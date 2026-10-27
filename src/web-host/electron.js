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

// electron.js — the `electron` module main's code imports, for the web build
// (scripts/build-web.mjs aliases `electron` here). Each export is the browser's
// nearest equivalent of Electron's object of the same name, so main.js and
// everything it requires run UNCHANGED: see .claude/rules/web.md.

import { EventEmitter, electronEvent } from "./events.js";
import { ctx } from "./context.js";
import { ipcMain } from "./ipc.js";
import { Menu, MenuItem } from "./menu.js";
import {
  BrowserWindow,
  closeAllPopups,
  getAppWindow,
  getThemeSource,
  setThemeSource,
} from "./windows.js";
import { t } from "./strings.js";
import { Buffer } from "./node/buffer.js";
import * as path from "./node/path.js";

export { ipcMain, Menu, MenuItem, BrowserWindow };

// ── app ──────────────────────────────────────────────────────────────────────

const PATHS = {
  userData: "/userData",
  appData: "/userData",
  home: "/Home",
  documents: "/Documents",
  downloads: "/Downloads",
  desktop: "/Documents",
  temp: "/tmp",
  logs: "/userData/logs",
};

let resolveReady;
const ready = new Promise((resolve) => (resolveReady = resolve));
let isReady = false;
let quitting = false;

class App extends EventEmitter {
  name = "Chip Hippo";
  isPackaged = true;
  // No dock on the web; main checks for one before it sets the icon.
  dock = undefined;

  getVersion() {
    return ctx.build.version;
  }

  getName() {
    return this.name;
  }

  getPath(name) {
    return PATHS[name] ?? `/${name}`;
  }

  getAppPath() {
    return "/app";
  }

  getLocale() {
    return globalThis.navigator?.language || "en";
  }

  getSystemLocale() {
    return this.getLocale();
  }

  getLocaleCountryCode() {
    try {
      return new Intl.Locale(this.getLocale()).maximize().region ?? "";
    } catch {
      return "";
    }
  }

  whenReady() {
    return ready;
  }

  isReady() {
    return isReady;
  }

  /** host-entry.js: everything main needs is in place. */
  _ready() {
    isReady = true;
    resolveReady();
    this.emit("ready", electronEvent());
  }

  // The single-instance lock is the tab's (host-entry.js takes a Web Lock
  // before main runs; a second tab of the app is told so instead).
  requestSingleInstanceLock() {
    return ctx.singleInstance;
  }

  releaseSingleInstanceLock() {}

  setAboutPanelOptions() {}

  /** Quitting a page is starting it over: the only route here is a restart
      to take an update, once the close guard has said yes. */
  quit() {
    if (quitting) return;
    const event = electronEvent();
    this.emit("before-quit", event);
    if (event.defaultPrevented) return;
    quitting = true;
    this.emit("will-quit", electronEvent());
    closeAllPopups();
    this.emit("quit", electronEvent(), 0);
    ctx.page.location.reload();
  }

  exit() {
    this.quit();
  }

  relaunch() {}

  focus() {
    getAppWindow()?.focus();
  }
}

export const app = new App();

// ── nativeTheme ──────────────────────────────────────────────────────────────

const darkQuery =
  globalThis.matchMedia?.("(prefers-color-scheme: dark)") ?? null;

class NativeTheme extends EventEmitter {
  get themeSource() {
    return getThemeSource();
  }

  set themeSource(source) {
    setThemeSource(source === "light" || source === "dark" ? source : "system");
    this.emit("updated");
  }

  get shouldUseDarkColors() {
    const source = getThemeSource();
    if (source === "dark") return true;
    if (source === "light") return false;
    return darkQuery?.matches ?? true;
  }

  get shouldUseHighContrastColors() {
    return false;
  }
}

export const nativeTheme = new NativeTheme();
darkQuery?.addEventListener?.("change", () => nativeTheme.emit("updated"));

// ── nativeImage ──────────────────────────────────────────────────────────────

export const nativeImage = {
  createFromPath: () => ({
    isEmpty: () => false,
    toPNG: () => Buffer.alloc(0),
  }),
  createEmpty: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
};

// ── safeStorage ──────────────────────────────────────────────────────────────
// A page has no OS keychain. The AI key is kept in this browser's own storage,
// masked so it is not legible to anyone reading the stored bytes — which is all
// it is: anything that can run code on this site's origin can read it. The
// Settings ▸ AI panel and the user guide say so.

const MASK_FILE = "/userData/.key-mask";
const MAGIC = "CHW1";

function mask() {
  const { vfs } = ctx;
  if (!vfs.existsSync(MASK_FILE)) {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    vfs.mkdirSync(path.dirname(MASK_FILE), { recursive: true });
    vfs.writeFileSync(MASK_FILE, bytes);
  }
  return vfs.readFileSync(MASK_FILE);
}

function xor(bytes, key) {
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++)
    out[i] = bytes[i] ^ key[i % key.length];
  return out;
}

export const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "browser",
  encryptString(plain) {
    return Buffer.concat([
      Buffer.from(MAGIC),
      xor(Buffer.from(String(plain), "utf8"), mask()),
    ]);
  },
  decryptString(buf) {
    const bytes = Buffer.from(buf);
    if (bytes.subarray(0, 4).toString("latin1") !== MAGIC)
      throw new Error("not a stored key");
    return xor(bytes.subarray(4), mask()).toString("utf8");
  },
};

// ── screen ───────────────────────────────────────────────────────────────────

function display() {
  const s = globalThis.screen ?? {};
  const width = s.width ?? 1440;
  const height = s.height ?? 900;
  return {
    id: 1,
    bounds: { x: 0, y: 0, width, height },
    workArea: {
      x: s.availLeft ?? 0,
      y: s.availTop ?? 0,
      width: s.availWidth ?? width,
      height: s.availHeight ?? height,
    },
    scaleFactor: globalThis.devicePixelRatio ?? 1,
    rotation: 0,
    internal: true,
  };
}

export const screen = Object.assign(new EventEmitter(), {
  getAllDisplays: () => [display()],
  getPrimaryDisplay: () => display(),
  getDisplayMatching: () => display(),
  getDisplayNearestPoint: () => display(),
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
});

// ── shell ────────────────────────────────────────────────────────────────────

const PDF_RE = /\.pdf$/i;

export const shell = {
  async openExternal(url) {
    const href = String(url);
    if (/^mailto:/i.test(href)) ctx.page.location.href = href;
    else ctx.page.open(href, "_blank", "noopener");
  },
  /** A file of ours, in a tab of its own: the browser shows a PDF itself. */
  async openPath(p) {
    try {
      const blob = await ctx.mounts.blob(
        p,
        PDF_RE.test(p) ? "application/pdf" : undefined,
      );
      const url = URL.createObjectURL(blob);
      const opened = ctx.page.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
      return opened
        ? ""
        : t("web.popupBlockedShort", "Your browser blocked the new tab.");
    } catch (err) {
      return String(err?.message ?? err);
    }
  },
  showItemInFolder() {},
  beep() {},
  trashItem: async () => {},
};

// ── dialog ───────────────────────────────────────────────────────────────────

export const dialog = {
  showOpenDialog: (a, b) => ctx.dialogs.showOpenDialog(a, b),
  showSaveDialog: (a, b) => ctx.dialogs.showSaveDialog(a, b),
  showMessageBox: (a, b) => ctx.dialogs.showMessageBox(a, b),
  showErrorBox: (title, content) => ctx.dialogs.showErrorBox(title, content),
};

// ── Odds and ends main or its modules may reach for ──────────────────────────

export const autoUpdater = undefined;
export const contextBridge = undefined;
export const ipcRenderer = undefined;
export const webContents = {
  getAllWebContents: () =>
    BrowserWindow.getAllWindows().map((w) => w.webContents),
  getFocusedWebContents: () =>
    BrowserWindow.getFocusedWindow()?.webContents ?? null,
};

// The browser asks the visitor for every permission itself: main's handlers
// (navigation-guard.js `guardPermissions`) have nothing to decide here.
export const session = {
  defaultSession: {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
  },
};
