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

// sources.js — WHERE THE GALLERY IS, the one statement of it (the gallery
// work, features/chiphippo-gallery-plan.md), beside the code that goes there
// (client.js) — the shape every outbound call in main has (ai/providers.js,
// datasheets/sources.js, updater.js).
//
// ONE HOST. The gallery is a static site at chiphippo.com/gallery/, built by
// the site's deploy from the public chiphippo-gallery repo. The renderer never
// names a URL: it asks for an ENTRY ID, and this file turns an id it can prove
// is one (`ENTRY_ID_RE`, which admits no `/`, `.` or `%`) and a file name from
// a closed list into the one address it may mean. So no request from the
// renderer can make main fetch anything else.
//
// AND ONE PLACE TO SEND TO. Share to Gallery posts a design to the gallery's
// submission service (services/gallery-worker/), which opens a pull request
// for it in the private chiphippo-gallery-submission repo — so the address
// a share goes to is stated here too, and only here.
//
// THE WEB BUILD reads its OWN site's gallery: the app is served from
// <site>/desktop/, the gallery from <site>/gallery/, so the base is resolved
// against the page's own address — the same origin the app was loaded from,
// and the production host when that is chiphippo.com.
"use strict";

const { ENTRY_ID_RE } = require("../../web/scripts/gallery/entry-format.js");

/** The gallery, as the desktop app reaches it. */
const GALLERY_BASE = "https://chiphippo.com/gallery/";

/** Where Share to Gallery sends a design: the submission service. */
const SHARE_URL = "https://share.chiphippo.com/v1/share";

/** A loopback address — the only kind a developer may point the app at. */
const LOOPBACK_RE = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?\//;

/** The files an entry publishes — the only names main will ask for. */
const ENTRY_FILES = Object.freeze([
  "entry.json",
  "design.desktop.chiphippo",
  "thumb.png",
]);

/**
 * The gallery's base address.
 * @param {{web?: boolean, pageUrl?: string|null, devBase?: string|null}} [where]
 *   - the web build passes its page's address, and gets the gallery beside
 *   it; a dev launch may pass a loopback `devBase`.
 */
function galleryBase({ web = false, pageUrl = null, devBase = null } = {}) {
  if (web && typeof pageUrl === "string" && pageUrl) {
    return new URL("../gallery/", pageUrl).href;
  }
  // A DEVELOPER's stand-in for the site (`CHIPHIPPO_GALLERY_URL`, honoured by
  // main.js only in a dev launch): a local `serve-web.mjs website` to try the
  // desktop app against. Loopback only, so not even a dev build can be
  // pointed at somebody else's host.
  if (typeof devBase === "string" && LOOPBACK_RE.test(devBase)) {
    return devBase.endsWith("/") ? devBase : `${devBase}/`;
  }
  return GALLERY_BASE;
}

/** The address of the gallery's index. */
function indexUrl(where) {
  return new URL("index.json", galleryBase(where)).href;
}

/**
 * The address of one file of one entry, or null when either is not one the
 * gallery publishes.
 * @param {string} id
 * @param {string} file - one of ENTRY_FILES.
 * @param {{web?: boolean, pageUrl?: string|null}} [where]
 * @returns {string|null}
 */
function entryFileUrl(id, file, where) {
  if (typeof id !== "string" || !ENTRY_ID_RE.test(id)) return null;
  if (!ENTRY_FILES.includes(file)) return null;
  return new URL(`entries/${id}/${file}`, galleryBase(where)).href;
}

/**
 * Where a share goes: the submission service, or — in a dev launch only
 * (`CHIPHIPPO_SHARE_URL`, as `devBase` above) — a loopback stand-in for it.
 * @param {{devUrl?: string|null}} [where]
 */
function shareUrl({ devUrl = null } = {}) {
  if (typeof devUrl === "string" && LOOPBACK_RE.test(devUrl)) return devUrl;
  return SHARE_URL;
}

module.exports = {
  GALLERY_BASE,
  SHARE_URL,
  shareUrl,
  ENTRY_FILES,
  galleryBase,
  indexUrl,
  entryFileUrl,
};
