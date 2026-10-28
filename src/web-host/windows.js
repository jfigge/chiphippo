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

// windows.js — Electron's BrowserWindow and webContents for the web build.
//
// The APP window is the tab itself: the first window main loads index.html
// into is bound to the page the visitor opened, which is already loading it.
// Every other window main opens (a pin-assignments window, the memory
// inspector, the chip designer, the CPU monitor, a floated slider, a serial
// log, the user guide) is a real browser POPUP — its own OS window, as on the
// desktop, movable to another screen. A popup's page loads the same preload,
// which finds this host through `window.opener` and attaches to the
// webContents named in its `window.name`.
//
// IPC crosses between windows exactly as Electron's does — by structured clone
// at each end (preload-entry.js clones what arrives; ipc.js clones what is
// asked), so no window ever holds another's objects.

import { EventEmitter, electronEvent } from "./events.js";
import { ctx } from "./context.js";
import { continueWith } from "./ui.js";
import { t } from "./strings.js";
import * as path from "./node/path.js";

const WINDOW_NAME_RE = /^chiphippo-wc-(\d+)$/;

let nextWindowId = 1;
let nextContentsId = 1;
const windows = new Map(); // id → BrowserWindow
const contents = new Map(); // id → WebContents
let appWindow = null;
let focusedId = null;

/** The site-relative URL of a file under the app's `web/` tree. */
function pageUrl(file, query) {
  const rel = path.relative("/web", path.resolve(file));
  const url = new URL(rel, ctx.baseUrl);
  for (const [k, v] of Object.entries(query ?? {}))
    url.searchParams.set(k, String(v));
  return url.href;
}

// The theme every window follows (nativeTheme.themeSource, electron.js).
let themeSource = "system";

/** Put the chosen palette on one document (theme.css's `data-theme`). */
export function applyTheme(doc) {
  const root = doc?.documentElement;
  if (!root) return;
  if (themeSource === "light" || themeSource === "dark")
    root.dataset.theme = themeSource;
  else delete root.dataset.theme;
}

export function setThemeSource(source) {
  themeSource = source;
  for (const wc of contents.values()) applyTheme(wc.domWindow?.document);
}

export function getThemeSource() {
  return themeSource;
}

export class WebContents extends EventEmitter {
  #window;
  #port = null;
  #destroyed = false;
  #loading = true;
  #url = "";
  #titleObserver = null;

  constructor(win) {
    super();
    this.id = nextContentsId++;
    this.#window = win;
    /** The DOM window this webContents' page is, once it exists. */
    this.domWindow = null;
    /** Where the last context-menu event was, for Menu.popup. */
    this.lastContextPoint = null;
    this.windowOpenHandler = null;
    contents.set(this.id, this);
  }

  get browserWindow() {
    return this.#window;
  }

  /** The page's preload has connected (or reconnected, after a reload). */
  attach(domWindow, port) {
    this.domWindow = domWindow;
    this.#port = port;
    this.#loading = true;
    this.#url = domWindow.location?.href ?? this.#url;
    applyTheme(domWindow.document);
    this.emit("did-start-loading");
    const loaded = () => {
      if (this.#destroyed) return;
      this.#loading = false;
      this.#watchTitle();
      this.emit("dom-ready");
      this.emit("did-finish-load");
      this.#window.emit("ready-to-show");
    };
    if (domWindow.document.readyState === "complete") queueMicrotask(loaded);
    else domWindow.addEventListener("load", loaded, { once: true });
  }

  /** The page went away (a reload on its way, or the window closing). */
  detach() {
    this.#port = null;
    this.#titleObserver?.disconnect();
    this.#titleObserver = null;
  }

  #watchTitle() {
    const doc = this.domWindow?.document;
    if (!doc || !this.listenerCount("page-title-updated") || !doc.head) return;
    const MutationObserverCtor = this.domWindow.MutationObserver;
    if (!MutationObserverCtor) return;
    this.#titleObserver?.disconnect();
    this.#titleObserver = new MutationObserverCtor(() => {
      const wanted = this.#window.getTitle();
      if (doc.title === wanted) return;
      const event = electronEvent();
      this.emit("page-title-updated", event, doc.title);
      if (event.defaultPrevented) doc.title = wanted;
    });
    this.#titleObserver.observe(doc.head, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }

  send(channel, ...args) {
    if (this.#destroyed || !this.#port) return;
    try {
      this.#port.deliver(channel, args);
    } catch (err) {
      console.error(`[web] could not deliver "${channel}":`, err);
    }
  }

  isDestroyed() {
    return this.#destroyed;
  }

  isLoading() {
    return this.#loading;
  }

  isLoadingMainFrame() {
    return this.#loading;
  }

  getURL() {
    return this.#url;
  }

  setURL(url) {
    this.#url = url;
  }

  getTitle() {
    return this.domWindow?.document?.title ?? "";
  }

  setWindowOpenHandler(fn) {
    this.windowOpenHandler = fn;
  }

  setVisualZoomLevelLimits() {
    return Promise.resolve();
  }

  focus() {
    this.domWindow?.focus();
  }

  selectAll() {
    this.domWindow?.document?.execCommand?.("selectAll");
  }

  reload() {
    this.domWindow?.location?.reload();
  }

  reloadIgnoringCache() {
    this.reload();
  }

  // A browser opens its own developer tools (its menu, ⌥⌘I / Ctrl+Shift+I);
  // a page cannot.
  openDevTools() {}

  closeDevTools() {}

  isDevToolsOpened() {
    return false;
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.detach();
    contents.delete(this.id);
    this.emit("destroyed");
  }
}

export class BrowserWindow extends EventEmitter {
  #title;
  #alwaysOnTop;
  #bounds;
  #destroyed = false;
  #visible;
  #popup = false;

  static getAllWindows() {
    return [...windows.values()].filter((w) => !w.isDestroyed());
  }

  static fromWebContents(wc) {
    return wc?.browserWindow && !wc.browserWindow.isDestroyed()
      ? wc.browserWindow
      : null;
  }

  static fromId(id) {
    return windows.get(id) ?? null;
  }

  static getFocusedWindow() {
    const win = focusedId != null ? windows.get(focusedId) : null;
    return win && !win.isDestroyed() ? win : appWindow;
  }

  constructor(opts = {}) {
    super();
    this.id = nextWindowId++;
    this.#title = opts.title ?? "Chip Hippo";
    this.#alwaysOnTop = opts.alwaysOnTop === true;
    this.#visible = opts.show !== false;
    this.#bounds = {
      x: Number.isFinite(opts.x) ? opts.x : null,
      y: Number.isFinite(opts.y) ? opts.y : null,
      width: opts.width ?? 800,
      height: opts.height ?? 600,
    };
    this.webContents = new WebContents(this);
    windows.set(this.id, this);
  }

  /** Whether this is the tab rather than a popup. */
  get isAppWindow() {
    return this === appWindow;
  }

  loadFile(file, opts = {}) {
    return this.#load(pageUrl(file, opts.query), path.basename(String(file)));
  }

  loadURL(url) {
    return this.#load(String(url), "");
  }

  async #load(url, base) {
    if (this.#destroyed) throw new Error("the window has been closed");
    this.webContents.setURL(url);
    // The app window: the page the visitor opened IS it, and is loading it.
    if (!appWindow && base === "index.html") {
      appWindow = this;
      bindAppWindow(this);
      return;
    }
    this.#popup = true;
    const features = [
      "popup",
      `width=${Math.round(this.#bounds.width)}`,
      `height=${Math.round(this.#bounds.height)}`,
    ];
    if (this.#bounds.x != null)
      features.push(`left=${Math.round(this.#bounds.x)}`);
    if (this.#bounds.y != null)
      features.push(`top=${Math.round(this.#bounds.y)}`);
    const name = `chiphippo-wc-${this.webContents.id}`;
    const open = () => ctx.page.open(url, name, features.join(","));
    let dom = open();
    if (!dom) {
      // No click behind this open (or the browser's pop-up blocker said no):
      // a click on the card is one.
      // An open that throws (continueWith rejects with it, and has logged it)
      // ends as a refused one does: the window is closed.
      dom = await continueWith(ctx.page.document, {
        title: this.#title,
        message: t(
          "web.popupBlocked",
          "Your browser stopped this window from opening. Allow pop-ups for this site, or open it now.",
        ),
        label: t("web.openWindow", "Open Window"),
        action: open,
      }).catch(() => null);
    }
    if (!dom) {
      this.#closed();
      return;
    }
    this.webContents.domWindow = dom;
    watchPopup(this);
  }

  /** The popup is gone (closed by its own ×, or by `close()`). */
  #closed() {
    if (this.#destroyed) return;
    this.emit("close", electronEvent());
    this.#destroyed = true;
    windows.delete(this.id);
    if (focusedId === this.id) focusedId = null;
    this.emit("closed");
    this.webContents.destroy();
  }

  /** Called by the popup watcher once the browser says the window has gone. */
  _gone() {
    this.#closed();
  }

  close() {
    if (this.#destroyed) return;
    if (this === appWindow) {
      const event = electronEvent();
      this.emit("close", event);
      if (event.defaultPrevented) return;
      // A tab cannot close itself; starting over is the nearest thing.
      ctx.page.location.reload();
      return;
    }
    const event = electronEvent();
    this.emit("close", event);
    if (event.defaultPrevented) return;
    try {
      this.webContents.domWindow?.close();
    } catch {
      // already gone
    }
    this.#closed();
  }

  destroy() {
    if (this === appWindow) return;
    try {
      this.webContents.domWindow?.close();
    } catch {
      // already gone
    }
    this.#closed();
  }

  isDestroyed() {
    return this.#destroyed;
  }

  show() {
    this.#visible = true;
    this.focus();
  }

  showInactive() {
    this.#visible = true;
  }

  hide() {
    this.#visible = false;
  }

  isVisible() {
    return this.#visible;
  }

  focus() {
    try {
      this.webContents.domWindow?.focus();
    } catch {
      // a window the browser will not focus from here
    }
  }

  isFocused() {
    return focusedId === this.id;
  }

  isMinimized() {
    return false;
  }

  isMaximized() {
    return false;
  }

  isFullScreen() {
    return false;
  }

  restore() {}

  minimize() {}

  maximize() {}

  setMenuBarVisibility() {}

  setAutoHideMenuBar() {}

  // A page cannot float a window above the others; the flag is kept so the
  // pin-assignments menu's tick still says what was chosen.
  setAlwaysOnTop(on) {
    this.#alwaysOnTop = Boolean(on);
  }

  isAlwaysOnTop() {
    return this.#alwaysOnTop;
  }

  setTitle(title) {
    this.#title = String(title);
    const doc = this.webContents.domWindow?.document;
    if (doc && this.#popup) doc.title = this.#title;
  }

  getTitle() {
    return this.#title;
  }

  #dom() {
    return this.webContents.domWindow ?? (this === appWindow ? ctx.page : null);
  }

  getBounds() {
    const w = this.#dom();
    if (!w || w.closed)
      return {
        x: this.#bounds.x ?? 0,
        y: this.#bounds.y ?? 0,
        width: this.#bounds.width,
        height: this.#bounds.height,
      };
    return {
      x: w.screenX,
      y: w.screenY,
      width: w.outerWidth,
      height: w.outerHeight,
    };
  }

  getNormalBounds() {
    return this.getBounds();
  }

  getContentBounds() {
    const w = this.#dom();
    if (!w || w.closed) return this.getBounds();
    // The page's own box on the screen: the frame's chrome sits above it.
    const chromeTop = Math.max(0, w.outerHeight - w.innerHeight);
    const chromeSide = Math.max(0, (w.outerWidth - w.innerWidth) / 2);
    return {
      x: Math.round(w.screenX + chromeSide),
      y: Math.round(w.screenY + chromeTop),
      width: w.innerWidth,
      height: w.innerHeight,
    };
  }

  setBounds(b) {
    if (Number.isFinite(b.x) && Number.isFinite(b.y))
      this.setPosition(b.x, b.y);
    if (Number.isFinite(b.width) && Number.isFinite(b.height))
      this.setSize(b.width, b.height);
  }

  getSize() {
    const b = this.getBounds();
    return [b.width, b.height];
  }

  getContentSize() {
    const b = this.getContentBounds();
    return [b.width, b.height];
  }

  setSize(width, height) {
    this.#bounds.width = width;
    this.#bounds.height = height;
    if (this.#popup) this.webContents.domWindow?.resizeTo?.(width, height);
  }

  setContentSize(width, height) {
    this.setSize(width, height);
  }

  getPosition() {
    const b = this.getBounds();
    return [b.x, b.y];
  }

  setPosition(x, y) {
    this.#bounds.x = x;
    this.#bounds.y = y;
    if (this.#popup) this.webContents.domWindow?.moveTo?.(x, y);
  }

  setMinimumSize() {}

  setMaximumSize() {}

  center() {}
}

// ── The app window ───────────────────────────────────────────────────────────

let appPort = null;

function bindAppWindow(win) {
  if (appPort) win.webContents.attach(ctx.page, appPort);
  ctx.page.addEventListener("focus", () => (focusedId = win.id));
  focusedId = win.id;
}

// ── Popups ───────────────────────────────────────────────────────────────────

const watched = new Set();
let watchTimer = null;

/** The browser has no event for a popup closing that the opener can hear
    reliably, so each is checked for `closed` while it is open. */
function watchPopup(win) {
  watched.add(win);
  watchTimer ??= setInterval(() => {
    for (const w of [...watched]) {
      const dom = w.webContents.domWindow;
      if (w.isDestroyed()) watched.delete(w);
      else if (!dom || dom.closed) {
        watched.delete(w);
        w._gone();
      }
    }
    if (!watched.size) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  }, 400);
}

/** Every popup this tab opened, closed with it. */
export function closeAllPopups() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win === appWindow) continue;
    try {
      win.webContents.domWindow?.close();
    } catch {
      // gone already
    }
  }
}

// ── Renderers connecting ─────────────────────────────────────────────────────

/**
 * A page's preload connecting: the tab's own (the app window), or a popup's,
 * found by the name the popup was opened under. Returns the webContents it now
 * speaks for, or null for a page that belongs to no window of ours.
 */
export function attachRenderer(domWindow, port) {
  if (domWindow === ctx.page) {
    appPort = port;
    if (appWindow) appWindow.webContents.attach(domWindow, port);
    return {
      kind: "app",
      get webContents() {
        return appWindow?.webContents ?? null;
      },
    };
  }
  const m = WINDOW_NAME_RE.exec(domWindow.name ?? "");
  const wc = m ? contents.get(Number(m[1])) : null;
  if (!wc || wc.isDestroyed()) return null;
  wc.attach(domWindow, port);
  domWindow.addEventListener("focus", () => (focusedId = wc.browserWindow.id));
  domWindow.addEventListener("pagehide", () => wc.detach());
  return { kind: "popup", webContents: wc };
}

/** The webContents a connected page speaks for, by the page's window. */
export function contentsOf(domWindow) {
  if (domWindow === ctx.page) return appWindow?.webContents ?? null;
  for (const wc of contents.values()) if (wc.domWindow === domWindow) return wc;
  return null;
}

export function getAppWindow() {
  return appWindow;
}

/** The DOM window a dialog for `win` belongs in: its own, else the focused
    window's, else the tab. */
export function domWindowFor(win) {
  const own = win?.webContents?.domWindow;
  if (own && !own.closed) return own;
  const focused = BrowserWindow.getFocusedWindow()?.webContents?.domWindow;
  return focused && !focused.closed ? focused : ctx.page;
}
