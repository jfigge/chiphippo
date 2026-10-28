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
 * may open. A port once granted stays in the browser's own port list from then
 * on.
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

/**
 * Open a manufacturer's datasheet PDF in a browser window of its own — the web
 * build's datasheet button (pinout.js). Called straight from the click, in the
 * window that was clicked: a popup opened anywhere else, or after an await, has
 * no gesture behind it and the browser blocks it. Only an https URL, which is
 * what main's table names; anything else is refused.
 * @param {string} url
 * @returns {boolean} whether it was handed to the browser.
 */
export function openDatasheetWindow(url) {
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) return false;
  const scr = globalThis.screen;
  const width = Math.min(1000, scr?.availWidth || 1000);
  const height = Math.min(1200, scr?.availHeight || 900);
  // `popup` (with a size) asks for a WINDOW rather than a tab; `noopener` so
  // the manufacturer's page gets no handle back into the app.
  globalThis.open(
    url,
    "_blank",
    `popup,noopener,noreferrer,width=${width},height=${height}`,
  );
  return true;
}
