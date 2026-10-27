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

// store-build.js — the single source of truth for "is this a sandboxed store
// build?" (Feature 280).
//
// Chip Hippo ships ONE codebase down several channels: the direct downloads cut
// by `make dist` (DMG/ZIP, NSIS/portable, AppImage/deb/rpm) and the Mac App Store
// package `make mas` builds. A store build runs under the store's own policy,
// so a feature the store forbids — or supplies itself — has to be off there.
// Rather than branch the BUILD, every such feature gates on the helpers below
// at RUNTIME, which is why there is exactly one place to look.
//
// Electron sets these globals for us; we never set them ourselves:
//   • process.mas          true in a Mac App Store build (sandboxed MAS Electron).
//   • process.windowsStore true in an appx/MSIX build (Microsoft Store).
//
// Two gates today:
//   • `selfUpdates()` — the self-updater. Both stores deliver their own
//     updates, electron-builder strips the update feed from a MAS/appx
//     package, and Apple's sandbox forbids an app replacing itself — so a
//     store build (and a package manager's, below) offers no "Check for
//     Updates…" menu item, no About-tab controls, and never makes the
//     outbound check at all.
//   • `allowsDonations()` — the About card's voluntary sponsor link. Apple's
//     Guideline 3.1.1 bars a link to a purchase mechanism other than in-app
//     purchase, and a tip jar counts; the Microsoft Store permits one. So it is
//     scoped to the MAS alone (as Rest Hippo's is), which is why `isMas()` is
//     kept distinct: the two stores are NOT interchangeable.
// Chip Hippo has no Microsoft Store channel yet; the flag costs nothing and
// means adding one is a packaging change, not a code change.
//
// A third channel is neither: a PACKAGE MANAGER's copy — the AUR's
// `chiphippo-bin`, which repackages the release .deb for pacman. Nothing in
// Electron says so, and the .deb's own `resources/package-type` says "deb",
// which would have electron-updater run `pkexec dpkg -i` on an Arch system
// (and, were it to work, replace files pacman owns). So the package writes a
// marker file, `resources/package-managed`, and `isPackageManaged()` reads it:
// pacman delivers the updates, and the self-updater stands down exactly as it
// does for a store. It is not a store — the sandbox rules and the donation
// link are untouched — which is why `selfUpdates()` is the gate the updater
// reads, not `isStoreBuild()`.
//
// A Windows PORTABLE copy (`make dist`'s portable .exe) is a direct download
// that cannot replace itself: electron-updater's Windows path downloads the
// NSIS Setup and installs it on quit — a SECOND, installed copy, silently,
// beside the portable one the user runs. electron-builder's portable stub
// sets PORTABLE_EXECUTABLE_DIR; `isPortable()` reads it, and the build counts
// as "portable", which does not self-update.
//
// A fourth is not Electron at all: the WEB build, this same main code run in a
// browser tab by src/web-host/ (`isWebBuild`). It updates itself — a new deploy
// reaches it through its service worker — so `selfUpdates()` is true there too,
// and the About card names it ("web").
"use strict";

const fs = require("fs");
const path = require("path");

/** The marker a package manager's build carries in its resources folder
    (packaging/aur/PKGBUILD.in writes it). */
const PACKAGE_MARKER = "package-managed";

/** True in a Mac App Store (sandboxed) build. */
function isMas() {
  return process.mas === true;
}

/** True in a Microsoft Store (appx/MSIX) build. */
function isAppx() {
  return process.windowsStore === true;
}

/** True in the WEB build — main's code running in a browser tab
    (src/web-host/, .claude/rules/web.md). Electron never sets this; the web
    host's stand-in for Node's `process` (web-host/node/globals.js) does. It
    updates itself (a new deploy, through its service worker), so it counts
    with the direct download for `selfUpdates`. */
function isWebBuild() {
  return process.webBuild === true;
}

/** True in a Windows portable build (its launcher sets the variable). */
function isPortable() {
  return (
    process.platform === "win32" &&
    typeof process.env?.PORTABLE_EXECUTABLE_DIR === "string" &&
    process.env.PORTABLE_EXECUTABLE_DIR !== ""
  );
}

/** True in any store build (Mac App Store OR Microsoft Store). */
function isStoreBuild() {
  return isMas() || isAppx();
}

/** True when a package manager installed this copy and delivers its updates
    (the marker above). Read on every call — it is asked rarely, and a test
    points `process.resourcesPath` at a folder of its own. */
function isPackageManaged() {
  const dir = process.resourcesPath;
  if (typeof dir !== "string" || dir === "") return false;
  try {
    return fs.existsSync(path.join(dir, PACKAGE_MARKER));
  } catch {
    return false;
  }
}

/** Does this build update itself? A direct download does, and so does the web
    build (a new deploy); a store and a package manager each deliver their
    own. */
function selfUpdates() {
  const channel = distribution();
  return channel === "direct" || channel === "web";
}

/** May this build offer the voluntary donation link? Everywhere but the Mac
    App Store (Guideline 3.1.1 — see the header). */
function allowsDonations() {
  return !isMas();
}

/**
 * Which channel produced this build, surfaced in the About dialog so a bug
 * report records it — "my updater does nothing" and "I installed it from the
 * App Store" are the same sentence, and only one of them gets written down.
 * @returns {"store" | "package" | "portable" | "direct" | "web"}
 */
function distribution() {
  if (isWebBuild()) return "web";
  if (isStoreBuild()) return "store";
  if (isPortable()) return "portable";
  return isPackageManaged() ? "package" : "direct";
}

module.exports = {
  isMas,
  isAppx,
  isStoreBuild,
  isPackageManaged,
  isPortable,
  isWebBuild,
  selfUpdates,
  allowsDonations,
  distribution,
  PACKAGE_MARKER,
};
