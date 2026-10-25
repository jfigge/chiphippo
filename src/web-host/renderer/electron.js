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

// renderer/electron.js — the `electron` module app/preload.js imports, for the
// web build's preload bundle: `contextBridge` puts the bridge on the page, and
// `ipcRenderer` reaches main (host-entry.js) — in this tab, or in the tab that
// opened this popup — with Electron's semantics: arguments and answers are
// structured clones, and a push arrives as `(event, ...args)`.

const listeners = new Map(); // channel → Set<fn>

/** The host this page belongs to: its own tab's, or its opener's. */
function findHost() {
  if (window.__chiphippoHost) return window.__chiphippoHost;
  try {
    return window.opener?.__chiphippoHost ?? null;
  } catch {
    return null; // an opener on another origin
  }
}

const port = {
  // Called by the host, synchronously, for every push to this page.
  deliver(channel, args) {
    const set = listeners.get(channel);
    if (!set?.size) return;
    const copy = structuredClone(args ?? []);
    const event = { sender: null, senderId: 0 };
    for (const fn of [...set]) {
      try {
        fn(event, ...copy);
      } catch (err) {
        console.error(`[renderer] "${channel}" listener failed:`, err);
      }
    }
  },
};

/** This page's connection, once the host is up. */
export const connection = new Promise((resolve) => {
  const connect = () => {
    const host = findHost();
    if (!host) return false;
    const link = host.attach(window, port);
    if (link) resolve(link);
    else window.close();
    return true;
  };
  if (connect()) return;
  // The app's own tab: the host starts after this script, and says so.
  window.addEventListener("chiphippo-host-ready", connect, { once: true });
});

function localError(err) {
  const out = new Error(String(err?.message ?? err));
  if (err?.code) out.code = err.code;
  return out;
}

export const ipcRenderer = {
  async invoke(channel, ...args) {
    const link = await connection;
    let result;
    try {
      result = await link.invoke(channel, args);
    } catch (err) {
      throw localError(err);
    }
    return result === undefined ? undefined : structuredClone(result);
  },
  on(channel, fn) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(fn);
    return ipcRenderer;
  },
  once(channel, fn) {
    const wrapped = (...args) => {
      ipcRenderer.removeListener(channel, wrapped);
      fn(...args);
    };
    return ipcRenderer.on(channel, wrapped);
  },
  removeListener(channel, fn) {
    listeners.get(channel)?.delete(fn);
    return ipcRenderer;
  },
  removeAllListeners(channel) {
    if (channel === undefined) listeners.clear();
    else listeners.delete(channel);
    return ipcRenderer;
  },
  // No one-way renderer → main messages exist in the bridge.
  send() {},
};

export const contextBridge = {
  exposeInMainWorld(key, api) {
    Object.defineProperty(window, key, {
      value: api,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  },
};
