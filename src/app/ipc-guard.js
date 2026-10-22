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

// ipc-guard.js — WHICH WINDOW may ask main for WHAT. Every window loads the
// one preload, so every window can reach every channel it exposes; the
// navigation guard and the CSP keep a foreign page out of all of them, and
// this is the second line. DENY BY DEFAULT: the app window may call anything
// (but another window's reports to it), and an auxiliary window only the few
// channels it really uses, listed below by window — so a channel added later
// answers the app window alone until someone says otherwise. A memory
// inspector speaks for its OWN chip and reads its own chip's file, a floated
// slider for its own part and field; the chip designer writes only its own
// layout settings.
//
// `senderAllowed` is the policy, pure so it unit-tests without Electron;
// `guardIpcMain` puts it in front of every handler registered after it, so
// the `ipcMain.handle("…")` calls stay what the parity test reads.
"use strict";

/** What every window reads: its language and its text size. */
const EVERY_WINDOW = new Set(["i18n:load", "settings:get"]);

/** What each auxiliary window calls beyond that (its own entry script and
    what it imports — tests/ipc-guard.test.js holds the lists to the code). */
const AUX_CHANNELS = Object.freeze({
  pinout: new Set([
    "pinout:chip",
    "pinout:open-designer",
    "datasheet:open",
    "demo:open",
  ]),
  docs: new Set(["docs:read"]),
  serialLog: new Set([
    "serial:log:read",
    "serial:log:clear",
    "serial:log:prefs",
    "serial:log:save",
    "serial:log:min-width",
    "serial:mock:send",
    "serial:mock:log",
    "serial:mock:fault",
  ]),
  memory: new Set(["mem:load", "mem:export"]),
  chipDesigner: new Set(["settings:set"]),
  cpuMonitor: new Set(),
  // A floated slider speaks to the app (`slider:to-host`, below) and reads
  // its language and text size; nothing more.
  slider: new Set(),
});

/** What a refused call answers — the shape every guarded handler already
    uses for a failure, so a caller (there should be none) reads a refusal. */
const FORBIDDEN = Object.freeze({
  ok: false,
  code: "forbidden",
  error: "Not available in this window.",
});

/** A settings patch the chip designer may write: its own layout keys only. */
function designerPatch(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const keys = Object.keys(raw);
  return keys.length > 0 && keys.every((k) => /^chipDesigner[A-Z]/.test(k));
}

/** Which auxiliary window `who` is, or null (unknown: nothing beyond
    EVERY_WINDOW). */
function auxKind(who) {
  if (who.memoryCompId != null) return "memory";
  if (who.isChipDesigner) return "chipDesigner";
  if (who.isCpuMonitor) return "cpuMonitor";
  if (who.sliderKey != null) return "slider";
  if (who.isPinout) return "pinout";
  if (who.isDocs) return "docs";
  if (who.isSerialLog) return "serialLog";
  return null;
}

/**
 * May the window `who` call `channel` with `args`?
 * @param {string} channel
 * @param {unknown[]} args
 * @param {{isApp: boolean, memoryCompId: string|null, memoryGuid?: string|null,
 *   isChipDesigner: boolean, isCpuMonitor?: boolean, isPinout?: boolean,
 *   isDocs?: boolean, isSerialLog?: boolean, sliderKey?: string|null}} who
 */
function senderAllowed(channel, args, who) {
  // A window's reports to the app are its own — never another's, the app's
  // included. An inspector speaks for its OWN chip, never another's.
  if (channel === "memory:to-host") {
    return who.memoryCompId != null && who.memoryCompId === args[0];
  }
  if (channel === "cpumonitor:to-host") return who.isCpuMonitor === true;
  if (channel === "chipdesign:to-host") return who.isChipDesigner === true;
  // A floated slider speaks for its OWN part and field (`c3:position`).
  if (channel === "slider:to-host") {
    return who.sliderKey != null && who.sliderKey === `${args[0]}:${args[1]}`;
  }
  if (who.isApp) return true;
  if (EVERY_WINDOW.has(channel)) return true;
  const kind = auxKind(who);
  if (!kind || !AUX_CHANNELS[kind].has(channel)) return false;
  // An inspector reads its OWN chip's file (named by the context the app
  // relayed it), never another chip's.
  if (channel === "mem:load") {
    return who.memoryGuid != null && args[0] === who.memoryGuid;
  }
  if (channel === "settings:set") return designerPatch(args[0]);
  return true;
}

/**
 * Put the policy in front of every handler `ipcMain.handle` registers from
 * here on. `identify(sender)` says which window a webContents is.
 * @param {{handle: Function}} ipcMain
 * @param {(sender: object) => object} identify - the `who` senderAllowed reads
 */
function guardIpcMain(ipcMain, identify) {
  const register = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) =>
    register(channel, (event, ...args) =>
      senderAllowed(channel, args, identify(event?.sender))
        ? fn(event, ...args)
        : FORBIDDEN,
    );
}

module.exports = { senderAllowed, guardIpcMain, FORBIDDEN, AUX_CHANNELS };
