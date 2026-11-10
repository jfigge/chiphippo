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

// deep-link.js — pure parsers for what the OS hands Chip Hippo (the gallery
// work, Phase 4): a `chiphippo://` link and a `.chiphippo` file, arriving by
// macOS's open-url/open-file or on the command line (a Windows/Linux launch,
// or a second instance's argv). Dependency-free and side-effect-free, in the
// cli-args.js style (tests: app/tests/deep-link.test.js).
//
// A LINK IS PARSED FOR AN ID, NEVER FOLLOWED AS A URL: the one link there is,
// `chiphippo://gallery/<id>`, names a gallery entry by the id ENTRY_ID_RE
// admits, and main turns that id into the one address it may mean
// (gallery/sources.js) — so a link cannot aim main at anything off its host
// table. Anything else is no link at all.
"use strict";

const path = require("node:path");

const { ENTRY_ID_RE } = require("../web/scripts/gallery/entry-format.js");

const SCHEME = "chiphippo";

/** The longest argv entry worth reading as a link (an id is short). */
const MAX_LINK_LENGTH = 256;

/**
 * Read a `chiphippo://` link.
 * @param {unknown} url
 * @returns {{kind: "gallery", id: string}|null}
 */
function parseDeepLink(url) {
  if (typeof url !== "string" || url.length > MAX_LINK_LENGTH) return null;
  // By hand rather than through URL: `chiphippo:` is no special scheme, so
  // URL's host/path split differs by runtime, and the shape is fixed anyway —
  // the host, one segment, an optional trailing slash, nothing after.
  const m = /^chiphippo:\/\/gallery\/([^/?#]+)\/?$/i.exec(url.trim());
  if (!m) return null;
  const id = m[1];
  return ENTRY_ID_RE.test(id) ? { kind: "gallery", id } : null;
}

/** Is `arg` a file the OS may hand us — a `.chiphippo` path? */
const isChiphippoFile = (arg) =>
  typeof arg === "string" &&
  !arg.startsWith("-") &&
  /\.chiphippo$/i.test(arg) &&
  !arg.toLowerCase().startsWith(`${SCHEME}:`);

/**
 * A `file:` URL's local path, or null (another host, or not a URL). By the
 * global `URL` rather than node:url's `fileURLToPath`, which the web build's
 * bundle has no stand-in for (main's code runs there unchanged).
 */
function filePathOf(arg) {
  let url;
  try {
    url = new URL(arg);
  } catch {
    return null;
  }
  if (url.protocol !== "file:") return null;
  if (url.hostname && url.hostname !== "localhost") return null;
  let local;
  try {
    local = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (!local || local.includes("\0")) return null;
  if (process.platform === "win32") {
    local = local.replace(/^\/([A-Za-z]:)/, "$1").replace(/\//g, "\\");
  }
  return local;
}

/**
 * What a launch's argv asks to open: each `chiphippo:` link, then each
 * `.chiphippo` file (resolved against the launch's own working directory —
 * a second instance's, not ours). Flags and everything else are skipped, so
 * Electron's and Chromium's own switches pass through untouched.
 * @param {string[]} argv
 * @param {{cwd?: string}} [opts]
 * @returns {({kind: "link", url: string}|{kind: "file", path: string})[]}
 */
function launchRequests(argv = [], { cwd = process.cwd() } = {}) {
  const args = Array.isArray(argv) ? argv.slice(1) : []; // [0] is the binary
  const out = [];
  for (const arg of args) {
    if (typeof arg !== "string") continue;
    if (arg.toLowerCase().startsWith(`${SCHEME}:`)) {
      out.push({ kind: "link", url: arg });
    } else if (/^file:/i.test(arg)) {
      // A Linux launch: the desktop entry's `%U` lets a file manager hand a
      // file over as a `file:` URL (GIO's do), `%20`s and all — a path to
      // decode, never one to resolve against the working directory.
      const local = filePathOf(arg);
      if (local && isChiphippoFile(local)) out.push({ kind: "file", path: local }); // prettier-ignore
    } else if (isChiphippoFile(arg)) {
      out.push({ kind: "file", path: path.resolve(cwd, arg) });
    }
  }
  return out;
}

module.exports = { SCHEME, parseDeepLink, launchRequests };
