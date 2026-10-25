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

// globals.js — the Node globals main's code (and the preload) reads, for the
// web build. scripts/build-web.mjs hands this file to esbuild as an `inject`, so
// a bare `process`, `Buffer`, `setImmediate` or `fetch` in any bundled module
// resolves to the export of the same name here, and nothing is put on the
// page's real global object.

import { Buffer } from "./buffer.js";

/** The visitor's OS as Node would name it — what decides ⌘ against Ctrl in
    every label, and the application menu's shape (main's `isMac`). */
function detectPlatform() {
  const nav = globalThis.navigator ?? {};
  const hint = `${nav.userAgentData?.platform ?? ""} ${nav.platform ?? ""} ${nav.userAgent ?? ""}`;
  if (/Mac|iPhone|iPad|iPod/i.test(hint)) return "darwin";
  if (/Win/i.test(hint)) return "win32";
  return "linux";
}

function chromeVersion() {
  const ua = globalThis.navigator?.userAgent ?? "";
  return /Chrom(?:e|ium)\/([\d.]+)/.exec(ua)?.[1] ?? "";
}

const listeners = new Map();

export const process = {
  platform: detectPlatform(),
  arch: "web",
  argv: [],
  env: {},
  // Read by app/store-build.js: this is the web distribution.
  webBuild: true,
  mas: false,
  windowsStore: false,
  resourcesPath: undefined,
  versions: { node: "", electron: "", chrome: chromeVersion() },
  cwd: () => "/",
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return process;
  },
  off(event, fn) {
    listeners.get(event)?.delete(fn);
    return process;
  },
  emitWarning: (msg) => console.warn(msg),
};

export function setImmediate(fn, ...args) {
  return setTimeout(() => fn(...args), 0);
}

export function clearImmediate(id) {
  clearTimeout(id);
}

// The one network seam main has (ai/client.js; datasheets/download.js is not
// offered on the web). A browser holds a cross-origin call to CORS, and
// Anthropic's API answers a browser only when it is told the caller knows the
// key is in the page — which it is: the visitor's own key, in the visitor's
// own browser. Nothing else about a request changes.
const ANTHROPIC_HOST = /(^|\.)anthropic\.com$/i;

export function __chiphippoFetch(input, init = {}) {
  let host = "";
  try {
    host = new URL(String(input?.url ?? input)).hostname;
  } catch {
    // Left for fetch itself to refuse.
  }
  if (ANTHROPIC_HOST.test(host)) {
    const headers = new Headers(init.headers ?? {});
    headers.set("anthropic-dangerous-direct-browser-access", "true");
    return globalThis.fetch(input, { ...init, headers });
  }
  return globalThis.fetch(input, init);
}

export { Buffer };
