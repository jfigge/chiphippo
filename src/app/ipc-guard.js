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
// this is the second line: a channel that writes the user's files, opens
// their projects, programs a ROM or installs an update answers the APP
// window only, and the few an auxiliary window really uses answer that
// window (a memory inspector its OWN chip; the chip designer only its own
// layout settings; the CPU monitor only its own messages to the app).
//
// `senderAllowed` is the policy, pure so it unit-tests without Electron;
// `guardIpcMain` puts it in front of every handler registered after it, so
// the `ipcMain.handle("…")` calls stay what the parity test reads.
"use strict";

/** Channels only the app window may call. */
const APP_ONLY = [
  /^project:/,
  /^desktop:/,
  /^updater:install$/,
  /^chipdesign:open$/,
  /^cpumonitor:(open|to-window)$/,
  /^memory:(open|to-inspector)$/,
  /^mem:(create|program|write|delete|path|pick-image)$/,
  // A real USB port, a download into a folder of the user's, a file written
  // where a dialog pointed: the app window's work alone.
  /^serial:(open|send|close)$/,
  /^datasheet:download$/,
  /^integration:save-file$/,
];

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

/**
 * May the window `who` call `channel` with `args`?
 * @param {string} channel
 * @param {unknown[]} args
 * @param {{isApp: boolean, memoryCompId: string|null, isChipDesigner: boolean, isCpuMonitor?: boolean}} who
 */
function senderAllowed(channel, args, who) {
  if (APP_ONLY.some((re) => re.test(channel))) return who.isApp;
  if (channel === "mem:load" || channel === "mem:export") {
    return who.isApp || who.memoryCompId != null;
  }
  // An inspector speaks for its OWN chip, never another's.
  if (channel === "memory:to-host") {
    return who.memoryCompId != null && who.memoryCompId === args[0];
  }
  // The CPU monitor's reports to the app (which CPU to show) — its own.
  if (channel === "cpumonitor:to-host") return who.isCpuMonitor === true;
  if (channel === "settings:set") {
    return who.isApp || (who.isChipDesigner && designerPatch(args[0]));
  }
  return true;
}

/**
 * Put the policy in front of every handler `ipcMain.handle` registers from
 * here on. `identify(sender)` says which window a webContents is.
 * @param {{handle: Function}} ipcMain
 * @param {(sender: object) => {isApp: boolean, memoryCompId: string|null, isChipDesigner: boolean, isCpuMonitor?: boolean}} identify
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

module.exports = { senderAllowed, guardIpcMain, FORBIDDEN };
