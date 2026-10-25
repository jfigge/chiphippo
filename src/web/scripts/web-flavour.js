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

// web-flavour.js — the renderer's one question about the WEB build (Chip Hippo
// served as a site, src/web-host/ — see .claude/rules/web.md): the few places
// a browser offers something different from the desktop app. The web build's
// preload puts `window.chiphippoWeb` on every page; Electron's never does, so
// in the desktop app every answer here is the desktop one.

/** Is this page the web build? */
export function isWeb() {
  return Boolean(globalThis.chiphippoWeb);
}

/** Can this browser reach a serial port at all (the Web Serial API)? On the
    desktop the answer is always yes. */
export function serialAvailable() {
  return !isWeb() || globalThis.chiphippoWeb.serial === true;
}

/**
 * Ask the browser for a USB serial device — its own chooser, which only a click
 * may open. A port once granted is one `serial.ports()` lists from then on.
 * @returns {Promise<boolean>} whether one was granted.
 */
export async function grantSerialPort() {
  try {
    await globalThis.navigator.serial.requestPort();
    return true;
  } catch {
    return false; // dismissed, or nothing chosen
  }
}
