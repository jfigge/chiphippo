/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// store-build.js — the single source of truth for "is this a sandboxed store
// build?" (Feature 280).
//
// Chip Hippo ships ONE codebase down several channels: the direct downloads cut
// by `make dist` (DMG/ZIP, NSIS/portable, AppImage/deb) and the Mac App Store
// package `make mas` builds. A store build runs under the store's own policy,
// so a feature the store forbids — or supplies itself — has to be off there.
// Rather than branch the BUILD, every such feature gates on the helpers below
// at RUNTIME, which is why there is exactly one place to look.
//
// Electron sets these globals for us; we never set them ourselves:
//   • process.mas          true in a Mac App Store build (sandboxed MAS Electron).
//   • process.windowsStore true in an appx/MSIX build (Microsoft Store).
//
// Today there is ONE gate, `isStoreBuild()`: the self-updater. Both stores
// deliver their own updates, electron-builder strips the update feed from a
// MAS/appx package, and Apple's sandbox forbids an app replacing itself — so a
// store build offers no "Check for Updates…" menu item, no About-tab controls,
// and never makes the outbound check at all. `isMas()` is kept distinct because
// the two stores are NOT interchangeable (MSIX is full-trust where MAS is
// sandboxed), so the next gate can be scoped to the store that needs it rather
// than to both. Chip Hippo has no Microsoft Store channel yet; the flag costs
// nothing and means adding one is a packaging change, not a code change.
"use strict";

/** True in a Mac App Store (sandboxed) build. */
function isMas() {
  return process.mas === true;
}

/** True in a Microsoft Store (appx/MSIX) build. */
function isAppx() {
  return process.windowsStore === true;
}

/** True in any store build (Mac App Store OR Microsoft Store). */
function isStoreBuild() {
  return isMas() || isAppx();
}

/**
 * Which channel produced this build, surfaced in the About dialog so a bug
 * report records it — "my updater does nothing" and "I installed it from the
 * App Store" are the same sentence, and only one of them gets written down.
 * @returns {"store" | "direct"}
 */
function distribution() {
  return isStoreBuild() ? "store" : "direct";
}

module.exports = { isMas, isAppx, isStoreBuild, distribution };
