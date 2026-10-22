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

// build-release-notes.mjs — write website/releases.html, the website's release
// notes, FROM website/release-notes.json: every release since 1.0.0, newest
// first, one line per commit that went into it.
//
// The JSON is the record and the page a projection of it, as chips.html is of
// the catalog — `make docs` (and so the deploy) re-renders it, and the
// committed copy is held to it by tests/website-releases.test.js. The lines up
// to 1.4.3 were written by hand from the commits; a NEW release's entry is
// added by `make release` through `--add`, one line per commit since the last
// tag, each its commit's subject — edit the JSON afterwards to say it better.
//
// Plain Node with no dependencies beyond git for `--add`.
//
//   node scripts/build-release-notes.mjs                 # render the page
//   node scripts/build-release-notes.mjs --add 1.5.0     # add 1.5.0, render
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LOGO, STYLE, esc } from "./build-chips-page.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const NOTES = resolve(ROOT, "website/release-notes.json");
export const OUT = resolve(ROOT, "website/releases.html");
const SITE_URL = "https://chiphippo.com";
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** The release commits `make release` itself makes, which are not news. */
export const isReleaseCommit = (subject) => /^Release v\d+\.\d+\.\d+$/.test(subject); // prettier-ignore

/**
 * A release's entry from its commits, oldest first, as `git log --format=%h
 * %s` lines. The version bump `make release` commits is left out.
 * @param {string} version
 * @param {string} date - YYYY-MM-DD
 * @param {string[]} lines
 * @returns {{version: string, date: string, commits: Array<{hash: string, summary: string}>}}
 */
export function releaseEntry(version, date, lines) {
  const commits = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(" ");
      return { hash: line.slice(0, at), summary: line.slice(at + 1).trim() };
    })
    .filter((c) => c.hash && !isReleaseCommit(c.summary));
  return { version, date, commits };
}

/**
 * The notes with `entry` added at the top. A version already listed is
 * refused: its lines may have been edited by hand, and a re-run must never
 * overwrite them.
 */
export function withRelease(notes, entry) {
  if (!VERSION_RE.test(entry.version)) {
    throw new Error(`not an x.y.z version: ${entry.version}`);
  }
  if (notes.releases.some((r) => r.version === entry.version)) {
    throw new Error(`release-notes.json already lists ${entry.version}`);
  }
  return { ...notes, releases: [entry, ...notes.releases] };
}

const git = (...args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

/** The commits since the last release tag, from git. */
function commitsSinceLastTag() {
  const last = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*.[0-9]*.[0-9]*", "HEAD"); // prettier-ignore
  const log = git("log", "--reverse", "--no-merges", "--format=%h %s", `${last}..HEAD`); // prettier-ignore
  return log ? log.split("\n") : [];
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The page's own pieces, on top of the chips page's chrome.
const NOTES_STYLE = `
    .release { margin-top: 44px; }
    .release h2 { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-top: 0; }
    .release-date { font-size: 0.85rem; font-weight: 600; color: var(--overlay-0); letter-spacing: 0; }
    .release-link { font-size: 0.85rem; font-weight: 600; letter-spacing: 0; margin-left: auto; }
    .release ul { list-style: none; }
    .release li { display: flex; gap: 14px; padding: 6px 0; border-bottom: 1px solid var(--surface-0); color: var(--subtext); }
    .release li:last-child { border-bottom: none; }
    .release li a.commit { flex-shrink: 0; font-family: "Cascadia Code", "JetBrains Mono", "Fira Code", monospace; font-size: 0.82rem; padding-top: 2px; color: var(--overlay-0); }
    .release li a.commit:hover { color: var(--accent); }`;

function renderRelease(repo, r) {
  const items = r.commits
    .map(
      (c) =>
        `      <li><a class="commit" href="https://github.com/${repo}/commit/${esc(c.hash)}" rel="noopener noreferrer">${esc(c.hash)}</a><span>${esc(c.summary)}</span></li>`,
    )
    .join("\n");
  const id = `v${r.version}`;
  return `  <section class="release" id="${id}">
    <h2>${id} <span class="release-date">${esc(r.date)}</span><a class="release-link" href="https://github.com/${repo}/releases/tag/${id}" rel="noopener noreferrer">Release on GitHub →</a></h2>
    <ul>
${items}
    </ul>
  </section>`;
}

/**
 * The whole of website/releases.html.
 * @param {{repo: string, releases: Array}} notes
 * @returns {string}
 */
export function renderReleasesPage(notes) {
  const { repo, releases } = notes;
  const description =
    "What changed in every Chip Hippo release since 1.0.0, one line for each change.";
  return `<!DOCTYPE html>
<!-- GENERATED by scripts/build-release-notes.mjs from website/release-notes.json
     — do not edit by hand. Change the JSON, then run \`make docs\`. -->
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <!-- The same meta CSP as privacy.html: no scripts at all, so script-src is
       'none'; the inline <style> is what needs 'unsafe-inline'. -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <meta name="description" content="${esc(description)}" />
  <title>Release notes — Chip Hippo</title>
  <link rel="canonical" href="${SITE_URL}/releases.html" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Chip Hippo" />
  <meta property="og:title" content="Release notes — Chip Hippo" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${SITE_URL}/releases.html" />
  <style>${STYLE}${NOTES_STYLE}
  </style>
</head>
<body>

<nav>
  <a class="nav-logo" href="/">
    <span class="logo-mark">
      ${LOGO(32)}
    </span>
    <span class="nav-wordmark">Chip Hippo</span>
  </a>
  <div class="nav-right">
    <a class="nav-link" href="/#features">Features</a>
    <a class="nav-link" href="/docs/">Guide</a>
    <a class="nav-link" href="/#downloads">Downloads</a>
    <a class="nav-link" href="https://github.com/${repo}" rel="noopener noreferrer">GitHub</a>
    <a class="btn btn-primary" href="/#downloads">Download</a>
  </div>
</nav>

<main class="page">
  <p class="page-tag">Releases</p>
  <h1>Release notes</h1>
  <p>
    Every Chip Hippo release since 1.0.0, newest first, with one line for each change
    that went into it. Each change links to its commit, and each release to its page on
    <a href="https://github.com/${repo}/releases" rel="noopener noreferrer">GitHub Releases</a>,
    where its installers are. The latest version is always on the
    <a href="/#downloads">download page</a>.
  </p>

${releases.map((r) => renderRelease(repo, r)).join("\n\n")}
</main>

<footer>
  <div class="footer-inner">
    <div class="footer-logo">
      <span class="logo-mark">
        ${LOGO(28)}
      </span>
      <span class="footer-name">Chip Hippo</span>
    </div>
    <p style="margin-bottom:14px">
      <a href="/">Home</a>
      &nbsp;·&nbsp;
      <a href="/docs/">Guide</a>
      &nbsp;·&nbsp;
      <a href="https://github.com/${repo}" rel="noopener noreferrer">GitHub</a>
      &nbsp;·&nbsp;
      <a href="https://github.com/sponsors/jfigge" rel="noopener noreferrer">Donate</a>
      &nbsp;·&nbsp;
      <a href="/privacy.html">Privacy</a>
      &nbsp;·&nbsp;
      <a href="/code-signing-policy.html">Code Signing</a>
      &nbsp;·&nbsp;
      <a href="https://github.com/${repo}/issues" rel="noopener noreferrer">Contact</a>
    </p>
    <p>Copyright &copy; 2026 Jason Figge. Released under the GNU General Public License v3.<br>
    Built with Electron &amp; Vanilla JS. No telemetry, no accounts, fully offline.</p>
  </div>
</footer>

</body>
</html>
`;
}

export const readNotes = () => JSON.parse(readFileSync(NOTES, "utf8"));

// ── Build ─────────────────────────────────────────────────────────────────────
// Only write when run directly, so a test can import the renderer.
const IS_MAIN =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (IS_MAIN) {
  let notes = readNotes();
  const at = process.argv.indexOf("--add");
  if (at !== -1) {
    const version = process.argv[at + 1] ?? "";
    const entry = releaseEntry(version, today(), commitsSinceLastTag());
    notes = withRelease(notes, entry);
    writeFileSync(NOTES, `${JSON.stringify(notes, null, 2)}\n`);
    console.log(
      `Added v${version} to website/release-notes.json (${entry.commits.length} commits)`,
    );
  }
  writeFileSync(OUT, renderReleasesPage(notes));
  console.log(
    `Wrote website/releases.html (${notes.releases.length} releases)`,
  );
}
