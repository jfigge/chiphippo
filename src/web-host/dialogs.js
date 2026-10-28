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

// dialogs.js — Electron's `dialog` for the web build.
//
// With the File System Access API (Chromium) the native pickers ARE native:
// Open, Save As, a folder — the visitor's real files, written back as main
// writes them (mounts.js). Without it (Safari, Firefox) a browser can upload
// a file and download one, and nothing else, so:
//
//   · OPEN brings a copy in: of a project, into the browser's own storage
//     (`/Browser/<name>`, listed in the card with each one's Download and
//     Delete); of anything else, for the one read that asked for it.
//   · SAVE AS of a PROJECT keeps it in the browser under the name given —
//     ⌘S then writes there as it would to a file, and the Open card is where
//     it is downloaded. Saving any other file (a desktop export, a .dig, a ROM
//     image, a log, a sketch) downloads it.
//   · a FOLDER to write into (Export To ▸ KiCad) downloads as one .zip; a
//     folder to read (the datasheet folder) is read for this session.
//
// A picker opened with no click behind it is refused by every browser; the
// card that then asks for one is `ui.continueWith`.

import * as path from "./node/path.js";
import { modal, messageBox, continueWith, el } from "./ui.js";
import { t } from "./strings.js";

const BROWSER_DIR = "/Browser";
const PROJECT_EXT = ".chiphippo";
const DESKTOP_EXT = ".desktop.chiphippo";

function hasFsAccess(win) {
  return typeof win?.showOpenFilePicker === "function";
}

/** Electron's filters as the File System Access API's `types`. */
function pickerTypes(filters) {
  const types = [];
  for (const f of filters ?? []) {
    const exts = (f.extensions ?? [])
      .filter((e) => e && e !== "*")
      .map((e) => `.${e}`);
    if (!exts.length) continue;
    types.push({
      description: f.name,
      accept: { "application/octet-stream": exts },
    });
  }
  return types;
}

/** The `accept` attribute of an upload input for the same filters. */
function acceptOf(filters) {
  const exts = [];
  for (const f of filters ?? []) {
    for (const e of f.extensions ?? []) {
      if (e === "*") return "";
      exts.push(`.${e}`);
    }
  }
  return exts.join(",");
}

function isAbort(err) {
  return err?.name === "AbortError";
}

function needsGesture(err) {
  return err?.name === "SecurityError" || err?.name === "NotAllowedError";
}

/** Run a picker; if the browser wants a click first, ask for one and retry. */
async function withGesture(doc, title, run) {
  try {
    return await run();
  } catch (err) {
    if (isAbort(err)) return null;
    if (!needsGesture(err)) throw err;
  }
  const result = await continueWith(doc, {
    title,
    message: t(
      "web.pickerNeedsClick",
      "Your browser needs a click before it opens this.",
    ),
    action: async () => {
      try {
        return await run();
      } catch (err) {
        if (isAbort(err)) return null;
        throw err;
      }
    },
  });
  return result ?? null;
}

/** An `<input type=file>` in `doc`, opened from a click; resolves its files. */
function upload(
  doc,
  { accept = "", directory = false, multiple = false } = {},
) {
  return new Promise((resolve) => {
    const input = doc.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    if (multiple) input.multiple = true;
    if (directory) input.webkitdirectory = true;
    input.style.display = "none";
    let settled = false;
    const finish = (files) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish([...(input.files ?? [])]));
    input.addEventListener("cancel", () => finish([]));
    // A browser too old for the `cancel` event says nothing when the picker is
    // dismissed; the window getting its focus back (with no `change` soon
    // after) is the same news, or a caller would wait for ever.
    doc.defaultView?.addEventListener(
      "focus",
      () => setTimeout(() => finish([...(input.files ?? [])]), 1500),
      { once: true },
    );
    doc.body.append(input);
    input.click();
  });
}

/** A name not yet used in the browser's own project folder. */
function freeBrowserName(vfs, wanted) {
  const ext = wanted.endsWith(DESKTOP_EXT) ? DESKTOP_EXT : path.extname(wanted);
  const stem = ext ? wanted.slice(0, -ext.length) : wanted;
  let name = wanted;
  for (let n = 2; vfs.existsSync(`${BROWSER_DIR}/${name}`); n++)
    name = `${stem} ${n}${ext}`;
  return name;
}

/** A file name the visitor typed, made safe to be one. */
function cleanName(raw, ext) {
  let name = [...String(raw ?? "")]
    .filter((c) => c.charCodeAt(0) >= 0x20 && !'\\/:*?"<>|'.includes(c))
    .join("")
    .trim();
  if (!name) return "";
  if (ext && !name.toLowerCase().endsWith(ext)) name += ext;
  return name;
}

export class Dialogs {
  #vfs;
  #mounts;
  #download;
  #windowOf;

  /**
   * @param {{vfs: import("./vfs.js").Vfs, mounts: import("./mounts.js").Mounts,
   *   download: (name: string, bytes: Uint8Array, win?: Window|null) => void,
   *   windowOf: (win: any) => Window}} deps - `windowOf` gives the DOM window
   *   a BrowserWindow (or none: the focused one) is shown in.
   */
  constructor({ vfs, mounts, download, windowOf }) {
    this.#vfs = vfs;
    this.#mounts = mounts;
    this.#download = download;
    this.#windowOf = windowOf;
  }

  /** Electron's (win?, opts) argument shape. */
  #args(a, b) {
    return b === undefined && a && !a.webContents ? [null, a] : [a, b ?? {}];
  }

  // ── showOpenDialog ────────────────────────────────────────────────────────

  async showOpenDialog(a, b) {
    const [win, opts] = this.#args(a, b);
    const dom = this.#windowOf(win);
    const props = new Set(opts.properties ?? []);
    const title = opts.title || t("web.openTitle", "Open");
    const paths = props.has("openDirectory")
      ? await this.#openFolder(dom, opts, props, title)
      : await this.#openFiles(dom, opts, props, title);
    return paths?.length
      ? { canceled: false, filePaths: paths, bookmarks: [] }
      : { canceled: true, filePaths: [] };
  }

  async #openFolder(dom, opts, props, title) {
    // Only a folder that will be WRITTEN INTO asks `promptToCreate` (Export To
    // ▸ KiCad). `createDirectory` is just macOS's New Folder button, and the
    // datasheet folder — read, never written — asks for it too: taken as a
    // write, Browse… there offered to download a .zip and stored the download
    // folder as the datasheet folder (Safari, 2026-10-28).
    const writing = props.has("promptToCreate");
    if (typeof dom.showDirectoryPicker === "function") {
      const mode = writing ? "readwrite" : "read";
      const handle = await withGesture(dom.document, title, () =>
        dom.showDirectoryPicker({ mode, id: "chiphippo-folder" }),
      );
      return handle ? [await this.#mounts.mountDir(handle, { mode })] : null;
    }
    if (writing) {
      // Nowhere to write a folder: what lands in it is downloaded as a .zip.
      const ok = await modal(dom.document, {
        title,
        message: t(
          "web.folderDownload",
          "Your browser can't save into a folder, so the files will be downloaded together as one .zip.",
        ),
        buttons: [
          { label: t("common.cancel", "Cancel"), value: false },
          { label: t("web.download", "Download"), value: true, primary: true },
        ],
        cancel: false,
      });
      return ok
        ? [
            this.#mounts.downloadDir(
              path.basename(opts.defaultPath || "Export"),
              { win: dom },
            ),
          ]
        : null;
    }
    const files = await continueWith(dom.document, {
      title,
      message: t(
        "web.folderSession",
        "Choose the folder. Your browser lets Chip Hippo read it until this page is closed.",
      ),
      label: t("web.chooseFolder", "Choose Folder…"),
      action: () => upload(dom.document, { directory: true, multiple: true }),
    });
    return files?.length ? [await this.#mounts.mountFileList(files)] : null;
  }

  async #openFiles(dom, opts, props, title) {
    const multiple = props.has("multiSelections");
    if (hasFsAccess(dom)) {
      const types = pickerTypes(opts.filters);
      const handles = await withGesture(dom.document, title, () =>
        dom.showOpenFilePicker({
          multiple,
          types: types.length ? types : undefined,
          excludeAcceptAllOption: false,
          id: "chiphippo-open",
        }),
      );
      if (!handles?.length) return null;
      const out = [];
      for (const handle of handles)
        out.push(await this.#mounts.mountFile(handle));
      return out;
    }
    const projects = (opts.filters ?? []).some((f) =>
      (f.extensions ?? []).includes("chiphippo"),
    );
    return projects
      ? this.#openBrowserCard(dom.document, opts, title)
      : this.#uploadOnce(dom.document, opts, title, multiple);
  }

  /** Non-project files without the API: read in for this one use. */
  async #uploadOnce(doc, opts, title, multiple) {
    const files = await continueWith(doc, {
      title,
      message: t("web.chooseFileMessage", "Choose a file from your computer."),
      label: t("web.chooseFile", "Choose File…"),
      action: () => upload(doc, { accept: acceptOf(opts.filters), multiple }),
    });
    if (!files?.length) return null;
    const out = [];
    for (const file of files) {
      const dir = `/Uploads/${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const p = `${dir}/${file.name}`;
      this.#vfs.restoreFile(p, new Uint8Array(await file.arrayBuffer()));
      out.push(p);
    }
    return out;
  }

  /** The projects this browser keeps, to open, download or delete — and an
      upload from the computer, which joins them. */
  #openBrowserCard(doc, opts, title) {
    const vfs = this.#vfs;
    return new Promise((resolve) => {
      let card = null;
      const list = el(doc, "ul", { class: "webhost-files" });
      const empty = el(doc, "p", {
        class: "popup-note",
        text: t(
          "web.noBrowserFiles",
          "No projects are kept in this browser yet.",
        ),
      });
      const render = () => {
        list.replaceChildren();
        const names = vfs.existsSync(BROWSER_DIR)
          ? vfs.readdirSync(BROWSER_DIR).filter((n) => n.endsWith(PROJECT_EXT))
          : [];
        empty.hidden = names.length > 0;
        for (const name of names) {
          const p = `${BROWSER_DIR}/${name}`;
          list.append(
            el(doc, "li", { class: "webhost-file" }, [
              el(doc, "button", {
                class: "webhost-file-open",
                type: "button",
                text: name.replace(/\.chiphippo$/, ""),
                title: name,
                onClick: () => card?.close(p),
              }),
              el(doc, "button", {
                class: "btn popup-btn btn--secondary",
                type: "button",
                text: t("web.download", "Download"),
                onClick: () =>
                  this.#download(name, vfs.readFileSync(p), doc.defaultView),
              }),
              el(doc, "button", {
                class: "btn popup-btn btn--danger",
                type: "button",
                text: t("common.delete", "Delete"),
                onClick: async () => {
                  const sure = await messageBox(doc, {
                    type: "warning",
                    message: t(
                      "web.deleteTitle",
                      "Delete “{name}” from this browser?",
                      { name },
                    ),
                    detail: t(
                      "web.deleteDetail",
                      "It can't be brought back unless you downloaded a copy.",
                    ),
                    buttons: [
                      t("common.cancel", "Cancel"),
                      t("common.delete", "Delete"),
                    ],
                    defaultId: 0,
                    cancelId: 0,
                  });
                  if (sure.response === 1) {
                    vfs.unlinkSync(p);
                    render();
                  }
                },
              }),
            ]),
          );
        }
      };
      render();
      const uploadBtn = el(doc, "button", {
        class: "btn popup-btn",
        type: "button",
        text: t("web.uploadProject", "Upload from Computer…"),
        onClick: async () => {
          const [file] = await upload(doc, { accept: acceptOf(opts.filters) });
          if (!file) return;
          vfs.mkdirSync(BROWSER_DIR, { recursive: true });
          const name = freeBrowserName(vfs, file.name);
          const p = `${BROWSER_DIR}/${name}`;
          vfs.writeFileSync(p, new Uint8Array(await file.arrayBuffer()));
          card?.close(p);
        },
      });
      modal(doc, {
        title,
        message: t(
          "web.browserFilesMessage",
          "Projects saved in this browser:",
        ),
        content: [
          list,
          empty,
          el(doc, "div", { class: "webhost-upload" }, [uploadBtn]),
        ],
        buttons: [{ label: t("common.cancel", "Cancel"), value: null }],
        cancel: null,
        onOpen: (c) => {
          card = c;
        },
      }).then((p) => resolve(p ? [p] : null));
    });
  }

  // ── showSaveDialog ────────────────────────────────────────────────────────

  async showSaveDialog(a, b) {
    const [win, opts] = this.#args(a, b);
    const dom = this.#windowOf(win);
    const suggested = path.basename(opts.defaultPath || "") || "Untitled";
    const title = opts.title || t("web.saveTitle", "Save");
    let target = null;
    if (hasFsAccess(dom)) {
      const types = pickerTypes(opts.filters);
      const handle = await withGesture(dom.document, title, () =>
        dom.showSaveFilePicker({
          suggestedName: suggested,
          types: types.length ? types : undefined,
          excludeAcceptAllOption: false,
          id: "chiphippo-save",
        }),
      );
      if (handle)
        target = await this.#mounts.mountFile(handle, { read: false });
    } else if (
      suggested.endsWith(PROJECT_EXT) &&
      !suggested.endsWith(DESKTOP_EXT)
    ) {
      target = await this.#saveToBrowser(dom.document, suggested, title);
    } else {
      target = this.#mounts.downloadFile(suggested, { win: dom });
    }
    return target
      ? { canceled: false, filePath: target, bookmark: undefined }
      : { canceled: true, filePath: undefined };
  }

  /** A project's Save As without the API: a name, kept in this browser. */
  async #saveToBrowser(doc, suggested, title) {
    const input = el(doc, "input", {
      class: "popup-input",
      type: "text",
      value: suggested.replace(/\.chiphippo$/, ""),
      "aria-label": t("web.nameLabel", "Name"),
    });
    let card = null;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        card?.close("save");
      }
    });
    const answer = await modal(doc, {
      title,
      message: t(
        "web.saveBrowserMessage",
        "Your browser can't save to a file on your computer, so this project is kept in the browser. Download a copy any time from File ▸ Open…",
      ),
      content: input,
      buttons: [
        { label: t("common.cancel", "Cancel"), value: null },
        { label: t("common.save", "Save"), value: "save", primary: true },
      ],
      cancel: null,
      onOpen: (c) => {
        card = c;
        input.focus();
        input.select();
      },
    });
    if (answer !== "save") return null;
    const name = cleanName(input.value, PROJECT_EXT);
    if (!name) return null;
    const p = `${BROWSER_DIR}/${name}`;
    if (this.#vfs.existsSync(p)) {
      const replace = await messageBox(doc, {
        type: "warning",
        message: t("web.replaceTitle", "“{name}” already exists. Replace it?", {
          name,
        }),
        buttons: [t("common.cancel", "Cancel"), t("web.replace", "Replace")],
        defaultId: 0,
        cancelId: 0,
      });
      if (replace.response !== 1) return null;
    }
    this.#vfs.mkdirSync(BROWSER_DIR, { recursive: true });
    return p;
  }

  // ── showMessageBox ────────────────────────────────────────────────────────

  async showMessageBox(a, b) {
    const [win, opts] = this.#args(a, b);
    return messageBox(this.#windowOf(win).document, opts);
  }

  showErrorBox(title, content) {
    return messageBox(this.#windowOf(null).document, {
      type: "error",
      message: title,
      detail: content,
    });
  }
}
