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

// ipc.js — Electron's ipcMain for the web build, and the one road a renderer's
// `ipcRenderer.invoke` takes to it.
//
// A call is answered only once what it wrote has landed: storage
// (persist.idle) and the visitor's own files (mounts.idle). So a save the
// renderer is told succeeded is a save that happened — and one the visitor's
// disk refused is answered as the error it was, after main itself had already
// done its part, exactly as a failed fs write would have thrown on the desktop.

import { ctx } from "./context.js";
import { reloadStrings } from "./strings.js";

const handlers = new Map();

/** Before a handler runs: what main is about to read, brought up to date. */
const BEFORE = {
  // A recent project is re-read from the visitor's disk — a click asked for
  // it, so the browser may ask the visitor for permission too.
  "project:open-recent": (args) => ctx.mounts?.refreshPath(args[0]),
  "project:regrant": (args) => ctx.mounts?.refreshPath(args[0]),
};

let persistAsked = false;

/** After a handler: anything it is worth doing once the call has landed. */
const AFTER = {
  // The first real save is the moment to ask the browser not to evict what it
  // keeps (a request no visitor is shown on load).
  "project:save": (args) => {
    if (persistAsked || !args[1]) return;
    persistAsked = true;
    globalThis.navigator?.storage?.persist?.().catch(() => {});
  },
  // The host's own words follow the language, as main's menu does.
  "settings:set": (args) => {
    if (args[0] && Object.hasOwn(args[0], "locale")) reloadStrings();
  },
};

export const ipcMain = {
  handle(channel, fn) {
    if (handlers.has(channel)) {
      throw new Error(
        `Attempted to register a second handler for '${channel}'`,
      );
    }
    handlers.set(channel, fn);
  },
  handleOnce(channel, fn) {
    this.handle(channel, (...args) => {
      handlers.delete(channel);
      return fn(...args);
    });
  },
  removeHandler(channel) {
    handlers.delete(channel);
  },
  // One-way renderer → main messages: the preload sends none.
  on() {
    return ipcMain;
  },
  once() {
    return ipcMain;
  },
  removeListener() {
    return ipcMain;
  },
  removeAllListeners() {
    return ipcMain;
  },
};

/** Every channel a handler is registered for (the bridge-parity test). */
export function handledChannels() {
  return [...handlers.keys()];
}

async function settle() {
  await ctx.persist?.idle();
  await ctx.mounts?.idle();
}

function remoteError(channel, err) {
  const inner =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return new Error(`Error invoking remote method '${channel}': ${inner}`);
}

/**
 * Run `channel`'s handler for a renderer, as Electron does: the event names
 * the sender; the arguments are the renderer's, cloned into this realm.
 */
export async function dispatch(sender, channel, rawArgs) {
  const fn = handlers.get(channel);
  if (!fn)
    throw new Error(
      `Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`,
    );
  const args = structuredClone(rawArgs ?? []);
  try {
    await BEFORE[channel]?.(args);
  } catch (err) {
    console.warn(`[web] before ${channel}:`, err);
  }
  let result;
  try {
    result = await fn(
      { sender, senderFrame: null, processId: 0, frameId: 0 },
      ...args,
    );
  } catch (err) {
    await settle().catch(() => {});
    throw remoteError(channel, err);
  }
  try {
    await settle();
  } catch (err) {
    throw remoteError(channel, err);
  }
  try {
    AFTER[channel]?.(args, result);
  } catch {
    // best effort
  }
  return result;
}
