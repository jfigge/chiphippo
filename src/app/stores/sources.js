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

// stores/sources.js — WHERE A PRIVATE STORE'S NETWORK CALLS MAY GO, the one
// statement of it (the private stores work, .claude/rules/stores.md), in the
// shape every outbound call in main has (gallery/sources.js,
// ai/providers.js): the hosts beside the code that goes there (github.js).
//
// A FOLDER store makes no network call at all — its sync client does. Only a
// GITHUB store reaches the network, and only after the user added one:
//   · github.com — the sign-in (OAuth's device flow: a code the user types at
//     github.com/login/device; no password and no redirect ever passes
//     through Chip Hippo);
//   · api.github.com — the store itself (its files, the repository, the
//     invitation), with the token the sign-in gave, which credential-store
//     binds to this origin.
//
// And the PAGES the Add Store guide may open in the browser (`GUIDE_PAGES`):
// a closed list, by key — the renderer names a key, never a URL.
"use strict";

const {
  GITHUB_REPO_RE,
  githubDir,
} = require("../../web/scripts/stores/store-format.js");

const GITHUB_LOGIN = "https://github.com";
const GITHUB_API = "https://api.github.com";

/**
 * Chip Hippo's GitHub OAuth App (device flow enabled), registered by the
 * maintainer. Its client id is PUBLIC by design — a device-flow app has no
 * secret to ship. Emptied, a GitHub store is not offered (`githubConfigured`). `CHIPHIPPO_GITHUB_CLIENT_ID` overrides it in
 * a dev launch only (main.js passes `devClientId`).
 */
// Jason's "Chip Hippo" OAuth App (github.com/jfigge), device flow on,
// expiring user tokens on. Public by design: no client secret is shipped.
const GITHUB_CLIENT_ID = "Ov23lixgbUNY4hbDuwEo";
/** What the sign-in asks for: `repo` is the only scope that reaches a
    PRIVATE repository (GitHub has no narrower one for an OAuth App). */
const GITHUB_SCOPE = "repo";

const CLIENT_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

/** The client id this launch uses, or "" (GitHub stores not offered). */
function githubClientId({ devClientId = null } = {}) {
  if (typeof devClientId === "string" && CLIENT_ID_RE.test(devClientId)) {
    return devClientId;
  }
  return CLIENT_ID_RE.test(GITHUB_CLIENT_ID) ? GITHUB_CLIENT_ID : "";
}

/** The pages the Add Store guide may open, by key. */
const GUIDE_PAGES = Object.freeze({
  "github-signup": "https://github.com/signup",
  "github-device": "https://github.com/login/device",
  "gdrive-download": "https://www.google.com/drive/download/",
  "gdrive-share": "https://support.google.com/drive/answer/2494822",
  "dropbox-download": "https://www.dropbox.com/install",
  "dropbox-share": "https://help.dropbox.com/share/share-with-others",
  "onedrive-download":
    "https://www.microsoft.com/microsoft-365/onedrive/download",
  "onedrive-share":
    "https://support.microsoft.com/office/share-onedrive-files-and-folders-9fcc2f7d-de0c-4cec-93b0-a82024800c07",
  "icloud-share":
    "https://support.apple.com/guide/icloud/share-files-and-folders-mm708c2a4a6a/icloud",
});

/** A guide page's address, or null for a key not on the list. */
function guidePage(key) {
  return Object.hasOwn(GUIDE_PAGES, key) ? GUIDE_PAGES[key] : null;
}

/** A GitHub store's own page — its folder, for one kept in a folder — and
    the page where its people are managed. */
function repoPage(repo, { access = false, dir = "" } = {}) {
  if (!GITHUB_REPO_RE.test(repo ?? "")) return null;
  if (access) return `https://github.com/${repo}/settings/access`;
  const folder = githubDir(dir);
  if (folder == null) return null;
  return `https://github.com/${repo}${folder ? `/tree/HEAD/${folder.split("/").map(encodeURIComponent).join("/")}` : ""}`; // prettier-ignore
}

module.exports = {
  GITHUB_API,
  GITHUB_LOGIN,
  GITHUB_SCOPE,
  GUIDE_PAGES,
  githubClientId,
  guidePage,
  repoPage,
};
