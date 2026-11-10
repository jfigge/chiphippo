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

// gate.js — main's gallery decisions with no Electron in them (the gallery
// work), as close-guard.js is the close question's: main.js keeps only the
// wiring — the settings it reads, the windows it sends to — and every rule
// that says yes or no lives here, where `node --test` can hold it.
//
//   · `galleryAllowed` / `galleryAnswer` — the gate every `gallery:*` read
//     passes: Gallery access "yes" on the desktop, always on the web.
//   · `prepareShare` — Share to Gallery up to the moment a byte would leave:
//     consent, the four fields, the snapshot built and named for its entry,
//     the size and ROM caps.
//   · `onRecentList` — the one test the Browse window's Recent cards and a
//     board picture are held to: a path ON the MRU list, nothing else.
//   · `createOpenQueue` — what the OS hands over (a file, a link), held until
//     the app window's page says it is listening, and held again once that
//     page is gone.
"use strict";

const {
  MAX_ROM_BYTES,
  MAX_SNAPSHOT_BYTES,
  checkEntryText,
  snapshotRoms,
} = require("../../web/scripts/gallery/entry-format.js");

/**
 * May main read the gallery right now? The web build is ON the gallery's
 * site, so it never asks; the desktop app only on a stored "yes".
 * @param {{distribution: string, galleryAccess: unknown}} facts
 */
function galleryAllowed({ distribution, galleryAccess }) {
  return distribution === "web" || galleryAccess === "yes";
}

/**
 * One gallery read, answered `{ok: true, ...value}` or `{ok: false, code}`:
 * "refused" without access — `read` is then never called — and a coded
 * failure's own code (client.js's), "unavailable" for anything else.
 * @param {boolean} allowed
 * @param {object} where - app/gallery/sources.js's `where`
 * @param {(where: object) => Promise<object>} read
 */
async function galleryAnswer(allowed, where, read) {
  if (!allowed) return { ok: false, code: "refused" };
  try {
    return { ok: true, ...(await read(where)) };
  } catch (err) {
    return { ok: false, code: err?.code ?? "unavailable" };
  }
}

/**
 * Share to Gallery, everything before the send: `{ok: true, design, entry}`
 * (the snapshot's text and the checked fields) or `{ok: false, code}` —
 * "refused" (consent is No), "invalid" (the fields, or no document),
 * "tooBig" (the snapshot past the gallery's cap) or "romTooBig" (its ROM
 * images past theirs — the Share dialog's own check cannot see the bytes,
 * which only main holds, so without this a share the dialog passed was
 * turned down in review).
 *
 * The desktop is named for the ENTRY — its checked title and description —
 * never the sharer's tab: the app's "already open?" test is the tab's name,
 * so a shared "Desktop 1" would switch every visitor to their own Desktop 1
 * and never open; and so every word that leaves is held to `checkEntryText`.
 *
 * @param {object} payload - the renderer's `{doc, customChips, entry}`
 * @param {{consent: unknown,
 *   buildSnapshot: (s: object) => object}} deps - `buildSnapshot` is
 *   ProjectStore.buildDesktopSnapshot (what Export writes, ROMs included).
 */
function prepareShare(payload, { consent, buildSnapshot }) {
  if (consent === "no") return { ok: false, code: "refused" };
  const { doc, customChips, entry } = payload ?? {};
  const fields = checkEntryText(entry);
  if (fields.problems.length) return { ok: false, code: "invalid" };
  let snapshot;
  try {
    snapshot = buildSnapshot({
      name: fields.value.title,
      description: fields.value.description,
      doc,
      customChips,
    });
  } catch {
    return { ok: false, code: "invalid" };
  }
  const design = JSON.stringify(snapshot);
  if (Buffer.byteLength(design, "utf8") > MAX_SNAPSHOT_BYTES) {
    return { ok: false, code: "tooBig" };
  }
  if (snapshotRoms(snapshot).bytes > MAX_ROM_BYTES) {
    return { ok: false, code: "romTooBig" };
  }
  return { ok: true, design, entry: fields.value };
}

/** Is `filePath` a project on the MRU list (`recent`)? */
function onRecentList(filePath, recent) {
  return (
    typeof filePath === "string" &&
    filePath !== "" &&
    Array.isArray(recent) &&
    recent.includes(filePath)
  );
}

/**
 * What the OS hands over, queued until the app window's page is listening.
 *
 * `handOver(request)` delivers at once when the page is ready (bringing the
 * window forward first) and otherwise keeps it — at most `max`, since a
 * launch handed a hundred files is not one. `flush()` is the page's
 * `app:opens-ready`: everything kept goes, in order. `reset()` is a page that
 * went (a reload, a crash, the window closed): what arrives next waits for the
 * NEXT page, never sent to one still loading.
 *
 * @param {{deliver: (request: object) => void, showWindow: () => void,
 *   hasWindow: () => boolean, max?: number}} deps
 */
function createOpenQueue({ deliver, showWindow, hasWindow, max = 16 }) {
  const pending = [];
  let ready = false;
  return {
    get ready() {
      return ready;
    },
    get pending() {
      return pending.length;
    },
    handOver(request) {
      // A running app comes forward; one still starting shows its window
      // itself.
      if (ready) showWindow();
      if (ready && hasWindow()) deliver(request);
      else if (pending.length < max) pending.push(request);
    },
    flush() {
      ready = true;
      for (const request of pending.splice(0)) deliver(request);
    },
    reset() {
      ready = false;
    },
  };
}

module.exports = {
  createOpenQueue,
  galleryAllowed,
  galleryAnswer,
  onRecentList,
  prepareShare,
};
