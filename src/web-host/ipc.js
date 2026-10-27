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

/**
 * Before a handler whose write the visitor's disk may yet refuse: how to take
 * back what main records of it once it has. On the desktop the refused write
 * throws before main gets that far; here main has gone on (see `settle`).
 */
const UNDO = {
  // A Save As to a file that did not take the project: main has already put
  // it in Open Recent. The list goes back to exactly what it was — what the
  // save added comes out, and a full list's last entry it pushed off (or an
  // entry it moved to the top) is put back where it stood.
  "project:save": (sender, args) => {
    if (!args[1]) return null;
    const list = () => {
      const recent = callAs(sender, "project:recent:list");
      return Array.isArray(recent) ? recent : [];
    };
    const same = (a, b) => a.length === b.length && a.every((p, i) => p === b[i]); // prettier-ignore
    const before = list();
    return () => {
      for (const p of list())
        if (!before.includes(p)) callAs(sender, "project:recent:remove", p);
      if (same(list(), before)) return;
      // Main has no call that adds an entry anywhere but the top, so its own
      // stored key is put back as it was (`settings.json`, which its store
      // re-reads on every get) — and a remove of nothing then has main
      // re-read, prune its bookmarks and rebuild its menu from it, as any
      // change to the list does.
      restoreRecent(before);
      callAs(sender, "project:recent:remove", null);
    };
  },
};

/** Main's settings file (its store's `settings.json` under userData). */
const SETTINGS_FILE = "/userData/settings.json";

/** Put main's stored `recentProjects` back to `list`, every other key kept. */
function restoreRecent(list) {
  let stored = {};
  try {
    stored = JSON.parse(ctx.vfs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    // no settings yet: the list is all there is to keep
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored))
    stored = {};
  ctx.vfs.writeFileSync(
    SETTINGS_FILE,
    JSON.stringify({ ...stored, recentProjects: list }, null, 2),
  );
}

/** One of main's handlers run by the host, for the window `sender` (main's
    ipc-guard answers each window only what it may ask). */
function callAs(sender, channel, ...args) {
  const fn = handlers.get(channel);
  if (!fn) return null;
  return fn({ sender, senderFrame: null, processId: 0, frameId: 0 }, ...args);
}

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

// The calls still out, and the one whose handler is running right now: a
// change to the filesystem is made under one of them (mounts.js tags each
// write to the visitor's disk with it).
const inflight = new Set();
let running = null;

/**
 * The IPC calls a filesystem change may be being made under: the one whose
 * handler is running; else those whose handler has not finished (an async
 * handler's writes after its first await — a page has no AsyncLocalStorage
 * to say WHICH, so with two out it is both, and a refusal is answered to
 * each rather than to whichever settles first); else every call still out.
 */
export function currentCalls() {
  if (running) return [running];
  const handling = [...inflight].filter((call) => call.handling);
  return handling.length ? handling : [...inflight];
}

/** The one call a change is made under, or null when it cannot be told. */
export function currentCall() {
  const calls = currentCalls();
  return calls.length === 1 ? calls[0] : null;
}

// What each call deleted of main's own files, so a call whose write to the
// visitor's disk is refused can be undone (below).
ctx.vfs.onChange((change) => {
  if (change.op !== "unlink" || !change.before) return;
  if (!change.path.startsWith("/userData/")) return;
  currentCall()?.removed.push({ path: change.path, ...change.before });
});

/**
 * Wait until what `call` wrote has landed: the visitor's disk first, then
 * storage. On the desktop a refused write THROWS, before main's next line —
 * so Save As never empties the working slot for a file that did not take
 * the project. Here main has already gone on when the disk refuses; so what
 * the call deleted of main's own files is put back before storage (held
 * meanwhile — `hold`) ever sees it gone, and the call answers the error.
 */
async function settle(call) {
  let failure = null;
  try {
    await ctx.mounts?.idle(call);
  } catch (err) {
    failure = err;
  }
  if (failure) {
    for (const { path, data, mode } of call.removed.reverse()) {
      try {
        if (!ctx.vfs.existsSync(path))
          ctx.vfs.writeFileSync(path, data, { mode });
      } catch (err) {
        console.warn(`[web] could not put back ${path}:`, err);
      }
    }
    try {
      call.undo?.();
    } catch (err) {
      console.warn(`[web] could not undo ${call.channel}:`, err);
    }
  }
  call.release?.();
  call.release = null;
  // Only what changed since the call began: a write of its own the timer
  // already tried and storage refused is still its failure.
  await ctx.persist?.idle(call.since);
  if (failure) throw failure;
}

function remoteError(channel, err) {
  const inner =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return new Error(`Error invoking remote method '${channel}': ${inner}`);
}

/** Storage waits while `call` has a write to the visitor's disk out. */
function holdIfOwing(call) {
  if (!call.release && ctx.mounts?.owes(call))
    call.release = ctx.persist?.hold() ?? null;
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
  const call = {
    channel,
    removed: [],
    release: null,
    undo: null,
    since: 0,
    handling: false,
  };
  inflight.add(call);
  try {
    try {
      await BEFORE[channel]?.(args);
    } catch (err) {
      console.warn(`[web] before ${channel}:`, err);
    }
    call.since = ctx.persist?.generation ?? 0;
    let result;
    try {
      try {
        call.undo = UNDO[channel]?.(sender, args) ?? null;
      } catch (err) {
        console.warn(`[web] undo for ${channel}:`, err);
      }
      let pending;
      running = call;
      call.handling = true;
      try {
        pending = fn(
          { sender, senderFrame: null, processId: 0, frameId: 0 },
          ...args,
        );
      } finally {
        running = null;
      }
      holdIfOwing(call);
      try {
        result = await pending;
      } finally {
        call.handling = false;
      }
      holdIfOwing(call);
    } catch (err) {
      await settle(call).catch(() => {});
      throw remoteError(channel, err);
    }
    try {
      await settle(call);
    } catch (err) {
      throw remoteError(channel, err);
    }
    try {
      AFTER[channel]?.(args, result);
    } catch {
      // best effort
    }
    return result;
  } finally {
    call.release?.();
    inflight.delete(call);
  }
}
