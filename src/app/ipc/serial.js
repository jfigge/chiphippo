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

/**
 * ipc/serial.js — the Arduino serial integration's IPC surface, and the log
 * windows. main.js calls `registerSerialIpc` once; everything else about the
 * integration in main lives under app/serial/.
 *
 *   serial:ports            every port the OS reports (Settings ▸ Integration,
 *                           and Run's check that a connection's port is there)
 *   serial:open  ([{id, signature}])
 *                           a Run opens its connections and greets each
 *                           device, holding it to the layout signature
 *   serial:close            Stop — and a renderer that has just (re)loaded
 *   serial:send  (id, index, width, value)
 *                           one Output frame; resolves once ACKed or given up
 *   serial:log:open (id, {background?})
 *                           a connection's floating CONNECTION WINDOW (a Run
 *                           opening the Mock's does it in the background: no
 *                           focus)
 *   serial:log:read (id)    …which reads the stream so far on opening, and
 *                           its remembered view (and, for the Mock, its state
 *                           and layout)
 *   serial:log:clear (id)   …empties the stream
 *   serial:log:prefs (id, prefs)
 *                           …remembers its filters and timestamps
 *   serial:log:save (id, text)
 *                           …and Save…: a text file wherever the user picks
 *   serial:log:min-width (width)
 *                           …and how narrow its footer lets it go — the
 *                           window that ASKS is the one sized
 *   serial:mock:send (index, width, value)
 *                           the Mock's window sends an Input value
 *   serial:mock:log (text)  …or log text
 *   serial:mock:fault (fault, on)
 *                           …or arms one of its one-shot faults
 *   integration:save-file (id, scope, name, text)
 *                           Generate's Save As…: one generated file, opening
 *                           where that file was last saved for this
 *                           connection and design (serial/saved-files.js)
 *
 * and the pushes, re-dispatched by the preload as `chiphippo:serial-*`:
 *
 *   serial:inbound  {id, index, width, value}  → the app window
 *   serial:restart  {id}                       → the app window
 *   serial:dropped  {id, detail}               → the app window
 *   serial:log      {id, reset?, t0, entries, partial, text}
 *                                              → that connection's window, and
 *                                                the app window when it carries
 *                                                log TEXT (the LG lamp)
 *   serial:mock     {id, open, connected, faults, layout}
 *                                              → the Mock's window
 *
 * The renderer names CONNECTION IDS, never devices or paths — which device a
 * connection means is read from settings, here (see serial-manager.js).
 */
"use strict";

const path = require("path");
const fs = require("fs");
const { SerialManager, CONNECTION_ID_RE } = require("../serial/serial-manager");
const {
  savedPath,
  rememberSaved,
  forgetDeleted,
} = require("../serial/saved-files");
const { listPorts, openPort } = require("../serial/ports");
const { resolveWindowBounds, trackWindowState } = require("../window-state");

/** A connection window's floor until its page measures its footer, the most
    that measurement may ask for, and its height floor. */
const LOG_MIN_WIDTH = 360;
const LOG_MAX_MIN_WIDTH = 1200;
const LOG_MIN_HEIGHT = 200;

/** The stream filters and the timestamp column, as a window last left them. */
const VIEW_DEFAULTS = Object.freeze({
  log: true,
  data: true,
  protocol: false,
  timestamps: false,
});

/** A generated file's name: what Save As… will write, by its extension. */
const GENERATED_NAME_RE = /^[\w .-]{1,64}\.(h|ino|py)$/;

/** The longest design SCOPE a save may be remembered under (an opaque
    `<project path>|<desktop id>` from the renderer). */
const MAX_SCOPE_LENGTH = 2048;

/** A file name from a connection's name and the moment: `Nano 2026-09-25 1402.txt`. */
function streamFileName(name, now = new Date()) {
  const safe =
    String(name ?? "")
      .replace(/[^\w .-]+/g, "_")
      .trim() || "serial";
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${safe.slice(0, 48)} ${stamp}.txt`;
}

/**
 * @param {object} deps
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {typeof Electron.BrowserWindow} deps.BrowserWindow
 * @param {Electron.Dialog} deps.dialog
 * @param {() => object} deps.getSettings - the current settings document
 * @param {(patch: object) => void} [deps.setSettings] - persist a patch (a
 *   connection window's remembered bounds and view)
 * @param {() => Array<object>} [deps.getDisplays] - `screen.getAllDisplays()`
 * @param {() => Electron.BrowserWindow|null} deps.getMainWindow
 * @param {(key: string, fallback: string) => string} deps.m - main's i18n
 * @param {() => string} deps.windowBackground
 * @param {Electron.NativeImage} [deps.icon]
 * @param {string} deps.appDir - src/app (for the preload)
 * @returns {{manager: SerialManager, closeAll: () => Promise<void>,
 *   closeWindows: () => void}}
 */
function registerSerialIpc(deps) {
  const { ipcMain, BrowserWindow, dialog, getSettings, getMainWindow, m } =
    deps;
  const logWindows = new Map(); // connection id → BrowserWindow

  const toMain = (channel, payload) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const manager = new SerialManager({
    connections: () => {
      const list = getSettings()?.serialConnections;
      return Array.isArray(list) ? list : [];
    },
    listPorts,
    openPort,
    emit: (event, payload) => {
      if (event === "log" || event === "mock") {
        const win = logWindows.get(payload.id);
        if (win && !win.isDestroyed()) {
          win.webContents.send(`serial:${event}`, payload);
        }
      }
      // The Mock's state is its window's business alone, and of a stream the
      // app window needs only the log TEXT its LG lamp flashes for — not the
      // hundreds of protocol entries a second a busy run makes.
      if (event === "mock") return;
      if (event === "log" && !payload.text) return;
      toMain(`serial:${event}`, payload);
    },
  });

  const validId = (id) => typeof id === "string" && CONNECTION_ID_RE.test(id);
  const byte = (n, max = 255) => Number.isInteger(n) && n >= 0 && n <= max;

  // ── A connection window's remembered state, per CONNECTION ─────────────
  // Where it was and how it was showing its stream, keyed by the connection's
  // ID — so a rename keeps it, and it is kept only while that connection
  // exists (or is the built-in Mock, which no list holds): deleting one in
  // Settings deletes its window's state with it (`forgetDeletedConnections`).
  const remembered = () => {
    const all = getSettings()?.connectionWindows;
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  };
  const live = (all) =>
    Object.fromEntries(
      Object.entries(all).filter(([id]) => manager.connection(id)),
    );
  const writeRemembered = (all) => {
    try {
      deps.setSettings({ connectionWindows: all });
    } catch (err) {
      console.error("[main] saving a connection window's state failed:", err);
    }
  };
  const viewOf = (id) => {
    const saved = remembered()[id] ?? {};
    const view = { ...VIEW_DEFAULTS };
    for (const key of Object.keys(VIEW_DEFAULTS)) {
      if (typeof saved[key] === "boolean") view[key] = saved[key];
    }
    return view;
  };
  const remember = (id, patch) => {
    // A window whose connection was deleted while it was open saves nothing
    // as it closes, or the state just forgotten would come straight back.
    if (!deps.setSettings || !manager.connection(id)) return;
    const all = live(remembered());
    all[id] = { ...(all[id] ?? {}), ...patch };
    writeRemembered(all);
  };

  /**
   * Open (or focus) a connection's log window, titled with its name. In the
   * BACKGROUND — a Run opening the Mock's — it is shown without taking focus
   * from the circuit, and one already on screen is left where it is.
   */
  function openLogWindow(id, { background = false } = {}) {
    const config = manager.connection(id);
    if (!config) return false;
    const existing = logWindows.get(id);
    if (existing && !existing.isDestroyed()) {
      existing.setTitle(config.name);
      if (background) {
        if (!existing.isVisible() || existing.isMinimized()) {
          existing.showInactive();
        }
        return true;
      }
      existing.show();
      existing.focus();
      return true;
    }
    // Where this connection's window was last, if it is still on a screen.
    const bounds = resolveWindowBounds(
      remembered()[id]?.bounds,
      deps.getDisplays?.() ?? [],
      // The Mock's window has its send panel docked under the stream.
      { width: 640, height: config.mock ? 620 : 440 },
    );
    const win = new BrowserWindow({
      ...bounds,
      minWidth: LOG_MIN_WIDTH,
      minHeight: LOG_MIN_HEIGHT,
      backgroundColor: deps.windowBackground(),
      icon: deps.icon,
      title: config.name,
      fullscreenable: false,
      show: !background,
      webPreferences: {
        preload: path.join(deps.appDir, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenuBarVisibility(false);
    win
      .loadFile(path.join(deps.appDir, "..", "web", "serial-log.html"), {
        query: { id },
      })
      .catch(() => {});
    if (background) win.once("ready-to-show", () => win.showInactive());
    // Remembered with its connection, as it moves and as it closes.
    trackWindowState(win, { save: (b) => remember(id, { bounds: b }) });
    // The page sets its own <title>; the window keeps the connection's name.
    win.on("page-title-updated", (e) => e.preventDefault());
    win.on("closed", () => {
      if (logWindows.get(id) === win) logWindows.delete(id);
    });
    logWindows.set(id, win);
    return true;
  }

  // ── Generate's Save As…, remembered per CONNECTION and design ─────────
  const savedFiles = () => getSettings()?.codegenSaves;
  const writeSavedFiles = (all) => {
    try {
      deps.setSettings({ codegenSaves: all });
    } catch (err) {
      console.error("[main] remembering a saved file failed:", err);
    }
  };

  /** The Save panel's file-type filter, by the generated file's extension. */
  const filterFor = (ext) =>
    ext === "py"
      ? { name: m("dialog.filter.python", "Python source"), extensions: ["py"] }
      : ext === "ino"
        ? { name: m("dialog.filter.sketch", "Arduino sketch"), extensions: ["ino"] } // prettier-ignore
        : { name: m("dialog.filter.header", "C/C++ header"), extensions: ["h"] }; // prettier-ignore

  /**
   * Generate's Save As…: one generated file — a header, a module, an example
   * program — wherever the user puts it. The panel opens on the path this
   * file was last saved to for this connection and design, if its folder is
   * still there, else on the bare name. The renderer's `name` only picks the
   * suggestion and the filter; it is never a path, and neither is `scope`,
   * which is only ever a key.
   */
  async function saveFile(id, scope, name, text) {
    if (
      !validId(id) ||
      typeof scope !== "string" ||
      scope.length > MAX_SCOPE_LENGTH ||
      typeof name !== "string" ||
      !GENERATED_NAME_RE.test(name) ||
      typeof text !== "string" ||
      !text
    ) {
      return null;
    }
    const previous = savedPath(savedFiles(), id, scope, name);
    const opts = {
      defaultPath:
        previous && fs.existsSync(path.dirname(previous)) ? previous : name,
      filters: [filterFor(GENERATED_NAME_RE.exec(name)[1])],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    };
    const win = getMainWindow();
    const r = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    try {
      fs.writeFileSync(r.filePath, text, "utf8");
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (deps.setSettings && manager.connection(id)) {
      writeSavedFiles(rememberSaved(savedFiles(), id, scope, name, r.filePath));
    }
    return { ok: true, path: r.filePath };
  }

  ipcMain.handle("serial:ports", () => manager.ports());
  ipcMain.handle("serial:open", (_event, requests) =>
    manager.open(
      Array.isArray(requests)
        ? requests.filter(
            (r) =>
              validId(r?.id) &&
              Number.isInteger(r.signature) &&
              r.signature >= 0 &&
              r.signature <= 0xffffffff,
          )
        : [],
    ),
  );
  ipcMain.handle("serial:close", () => manager.close());
  ipcMain.handle("serial:send", (_event, id, index, width, value) => {
    if (!validId(id) || !byte(index) || !byte(width, 16) || width < 1) {
      return { ok: false, code: "invalid" };
    }
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      return { ok: false, code: "invalid" };
    }
    return manager.send(id, index, width, value);
  });
  ipcMain.handle("serial:log:open", (_event, id, opts) =>
    validId(id)
      ? openLogWindow(id, { background: opts?.background === true })
      : false,
  );
  ipcMain.handle("serial:log:read", (_event, id) => {
    if (!validId(id)) return null;
    const config = manager.connection(id);
    return {
      name: config?.name ?? id,
      ...manager.logRead(id),
      view: viewOf(id),
      ...(config?.mock ? { mock: manager.mockState() } : {}),
    };
  });
  ipcMain.handle("serial:log:prefs", (_event, id, view) => {
    const config = validId(id) ? manager.connection(id) : null;
    if (!config || !view || typeof view !== "object") return false;
    const patch = {};
    for (const key of Object.keys(VIEW_DEFAULTS)) {
      if (typeof view[key] === "boolean") patch[key] = view[key];
    }
    remember(id, patch);
    return true;
  });
  // The page measures its footer (the font size and the language both move
  // it); main only keeps it between a floor and a sanity cap, and widens a
  // window already narrower — a remembered size from before a bigger font.
  ipcMain.handle("serial:log:min-width", (event, width) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || ![...logWindows.values()].includes(win)) return false;
    if (!Number.isFinite(width) || width <= 0) return false;
    const [outer, height] = win.getSize();
    const frame = outer - win.getContentSize()[0];
    const min = Math.min(
      Math.max(Math.ceil(width) + frame, LOG_MIN_WIDTH),
      LOG_MAX_MIN_WIDTH,
    );
    win.setMinimumSize(min, LOG_MIN_HEIGHT);
    if (outer < min) win.setSize(min, height);
    return true;
  });
  ipcMain.handle("serial:log:save", async (event, id, text) => {
    const config = validId(id) ? manager.connection(id) : null;
    if (!config || typeof text !== "string") return null;
    const win = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();
    const opts = {
      defaultPath: streamFileName(config.name),
      filters: [
        { name: m("dialog.filter.text", "Text"), extensions: ["txt", "log"] },
      ],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    };
    const r = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    try {
      fs.writeFileSync(r.filePath, text, "utf8");
      return { ok: true, path: r.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("serial:mock:send", (_event, index, width, value) => {
    if (!byte(index) || !byte(width, 16) || width < 1) {
      return { ok: false, code: "invalid" };
    }
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      return { ok: false, code: "invalid" };
    }
    return manager.mockSend(index, width, value);
  });
  ipcMain.handle("serial:mock:log", (_event, text) =>
    typeof text === "string" && text.length <= 4096
      ? manager.mockLog(text)
      : false,
  );
  ipcMain.handle("serial:mock:fault", (_event, fault, on) =>
    typeof fault === "string" ? manager.mockFault(fault, on === true) : false,
  );
  ipcMain.handle("serial:log:clear", (_event, id) => {
    if (validId(id)) manager.logClear(id);
    return null;
  });
  ipcMain.handle("integration:save-file", (_event, id, scope, name, text) =>
    saveFile(id, scope, name, text),
  );

  return {
    manager,
    closeAll: () => manager.close(),
    /** Close every connection window. They are no project's, so New/Open
        leaves them be — but they must not outlive the app window: one left
        on screen keeps `window-all-closed` from firing, and the app from
        quitting. */
    closeWindows: () => {
      for (const win of [...logWindows.values()]) {
        if (!win.isDestroyed()) win.close();
      }
    },
    /** Drop what is remembered for every connection that no longer exists
        — its window, and where its generated files were saved — called
        whenever the connection list is written. */
    forgetDeletedConnections: () => {
      if (!deps.setSettings) return;
      const all = remembered();
      const kept = live(all);
      if (Object.keys(kept).length !== Object.keys(all).length) {
        writeRemembered(kept);
      }
      const saves = savedFiles() ?? {};
      const keptSaves = forgetDeleted(saves, (id) => manager.connection(id));
      if (Object.keys(keptSaves).length !== Object.keys(saves).length) {
        writeSavedFiles(keptSaves);
      }
    },
    /** Keep each open log window's title in step with a renamed connection. */
    retitleLogs: () => {
      for (const [id, win] of logWindows) {
        const config = manager.connection(id);
        if (config && !win.isDestroyed()) win.setTitle(config.name);
      }
    },
  };
}

module.exports = { registerSerialIpc, streamFileName, VIEW_DEFAULTS };
