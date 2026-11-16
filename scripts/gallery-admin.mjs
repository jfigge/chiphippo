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

// gallery-admin.mjs — the maintainer's tool for the gallery's published
// entries: list them, and take one down.
//
//   node scripts/gallery-admin.mjs list
//   node scripts/gallery-admin.mjs delete <id> [--reason TEXT] [--dry-run] [--yes]
//   (make gallery-list / make gallery-delete ID=<id> [REASON=...])
//
// A shared design lives in TWO repos: the public jfigge/chiphippo-gallery
// (what the site is built from) and the private
// jfigge/chiphippo-gallery-submission (where it arrived, its PR merged). A
// take-down removes `entries/<id>/` from BOTH, each in one commit on main:
//   - from the gallery, because that is what the site publishes — the push
//     runs its validate.yml, which dispatches the site deploy, and the entry
//     is gone from chiphippo.com/gallery a few minutes later;
//   - from the submission repo, because publish.yml, run by hand
//     (workflow_dispatch), offers EVERY entry there and would put a design
//     taken down only from the gallery straight back. A deletion pushed there
//     publishes nothing (it copies only ADDED entries).
// With both gone the same design can be shared again, and arrives as a new
// PR to be reviewed like any other.
//
// The seeds (the app's own example desktops, website/gallery/seed.json) are
// not in either repo: they are read from each RELEASE, so one is taken out by
// editing seed.json and releasing. The tool says so rather than pretend.
//
// Everything goes through the GitHub CLI (`gh`, already logged in as the repos'
// owner) and the Git Data API — no clone, nothing written to this checkout.
// The ref is moved WITHOUT force, so a push that lands meanwhile (a publish)
// makes the update fail rather than be overwritten; the tool then starts that
// repo again from its new head.
//
// What it cannot undo: the gallery repo is PUBLIC, so the files stay in its
// git history, and a sharer's Settings ▸ Gallery ▸ Check status still reads
// Accepted (the PR was merged).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import { ENTRY_ID_RE } from "../src/web/scripts/gallery/entry-format.js";

export const GALLERY_REPO = "jfigge/chiphippo-gallery";
export const SUBMISSION_REPO = "jfigge/chiphippo-gallery-submission";
const BRANCH = "main";
const SEED_FILE = new URL("../website/gallery/seed.json", import.meta.url);

// ── pure ─────────────────────────────────────────────────────────────────────

/** The blobs of one entry in a recursive tree listing — `entries/<id>/…` and
    nothing whose folder merely starts with the id. */
export function entryBlobs(tree, id) {
  const prefix = `entries/${id}/`;
  return tree.filter((t) => t.type === "blob" && t.path.startsWith(prefix));
}

/** The ids of the entries a recursive tree listing holds (folders under
    entries/ named as an entry id). */
export function entryIds(tree) {
  const ids = new Set();
  for (const t of tree) {
    const m = /^entries\/([^/]+)\//.exec(t.path);
    if (m && ENTRY_ID_RE.test(m[1])) ids.add(m[1]);
  }
  return [...ids].sort();
}

/** The `POST /git/trees` body that removes `blobs` from `baseTree`: a null
    sha deletes a path. */
export function deletionTree(baseTree, blobs) {
  return {
    base_tree: baseTree,
    tree: blobs.map((b) => ({ path: b.path, mode: b.mode, type: "blob", sha: null })), // prettier-ignore
  };
}

/** The commit message for a take-down. The gallery repo is public, so the
    reason is written only when one is given. */
export function removalMessage(id, title, reason) {
  const subject = `Remove ${title ? `${title} (${id})` : id}`;
  return reason ? `${subject}\n\nTaken down: ${reason}\n` : `${subject}\n`;
}

/** The seed with this id, if it is one (seeds are the release's, not a repo's). */
export function seedNamed(seed, id) {
  return (seed?.entries ?? []).find((e) => e.id === id) ?? null;
}

// ── GitHub ───────────────────────────────────────────────────────────────────

function gh(args, input) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    if (err.code === "ENOENT")
      throw new Error("the GitHub CLI (gh) is not installed");
    const detail = String(err.stderr || err.message).trim();
    const e = new Error(detail);
    e.status = Number(/HTTP (\d{3})/.exec(detail)?.[1]) || 0;
    throw e;
  }
}

const api = (path) => JSON.parse(gh(["api", path]));
const send = (method, path, body) =>
  JSON.parse(gh(["api", "-X", method, path, "--input", "-"], JSON.stringify(body))); // prettier-ignore

function head(repo) {
  const ref = api(`repos/${repo}/git/ref/heads/${BRANCH}`);
  const commit = api(`repos/${repo}/git/commits/${ref.object.sha}`);
  const listing = api(`repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
  if (listing.truncated)
    throw new Error(`${repo}'s tree is too large to list in one call`);
  return { sha: ref.object.sha, tree: commit.tree.sha, items: listing.tree };
}

function entryJson(repo, id) {
  try {
    const raw = gh([
      "api",
      "-H",
      "Accept: application/vnd.github.raw",
      `repos/${repo}/contents/entries/${id}/entry.json?ref=${BRANCH}`,
    ]);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Remove `entries/<id>/` from `repo` in one commit. Returns the new commit's
    sha, or null when the repo does not hold the entry. */
function removeFrom(repo, id, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const at = head(repo);
    const blobs = entryBlobs(at.items, id);
    if (blobs.length === 0) return null;
    const tree = send("POST", `repos/${repo}/git/trees`, deletionTree(at.tree, blobs)); // prettier-ignore
    const commit = send("POST", `repos/${repo}/git/commits`, {
      message,
      tree: tree.sha,
      parents: [at.sha],
    });
    try {
      send("PATCH", `repos/${repo}/git/refs/heads/${BRANCH}`, {
        sha: commit.sha,
        force: false,
      });
      return commit.sha;
    } catch (err) {
      // 422: main moved under us (not a fast-forward) — start again from it.
      if (err.status !== 422) throw err;
    }
  }
  throw new Error(`${repo}'s ${BRANCH} kept moving; try again`);
}

// ── commands ─────────────────────────────────────────────────────────────────

function list() {
  const ids = entryIds(head(GALLERY_REPO).items);
  if (ids.length === 0) console.log("No shared designs in the gallery.");
  for (const id of ids) {
    const e = entryJson(GALLERY_REPO, id) ?? {};
    console.log(
      `${id}\n    ${e.title ?? "(no entry.json)"} — ${e.author ?? "?"}` +
        (e.created ? `, ${e.created}` : ""),
    );
  }
  const seeds = JSON.parse(readFileSync(SEED_FILE, "utf8")).entries ?? [];
  console.log(
    `\n${ids.length} shared, plus ${seeds.length} seeds (website/gallery/seed.json).`,
  );
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

async function remove(id, { reason, dryRun, yes }) {
  if (!ENTRY_ID_RE.test(id ?? "")) {
    console.error(`"${id ?? ""}" is not a gallery entry id (like four-bit-counter-3fa9c1).`); // prettier-ignore
    return 2;
  }
  const seed = seedNamed(JSON.parse(readFileSync(SEED_FILE, "utf8")), id);
  if (seed) {
    console.error(
      `${id} is a seed ("${seed.title}"),\n` +
        "one of the app's own examples. Seeds are read from each release, not\n" +
        "from the gallery repo: take it out of website/gallery/seed.json and it\n" +
        "leaves the site with the next release.",
    );
    return 1;
  }

  const inGallery = entryBlobs(head(GALLERY_REPO).items, id);
  const inSubmission = entryBlobs(head(SUBMISSION_REPO).items, id);
  if (inGallery.length === 0 && inSubmission.length === 0) {
    console.error(
      `${id} is in neither ${GALLERY_REPO} nor ${SUBMISSION_REPO}.`,
    );
    return 1;
  }
  const entry =
    (inGallery.length && entryJson(GALLERY_REPO, id)) ||
    (inSubmission.length && entryJson(SUBMISSION_REPO, id)) ||
    {};

  console.log(`${id}: "${entry.title ?? "?"}" by ${entry.author ?? "?"}`);
  for (const [repo, blobs] of [
    [GALLERY_REPO, inGallery],
    [SUBMISSION_REPO, inSubmission],
  ])
    console.log(
      blobs.length
        ? `  ${repo}: remove ${blobs.map((b) => b.path.slice(`entries/${id}/`.length)).join(", ")}` // prettier-ignore
        : `  ${repo}: not there`,
    );
  if (dryRun) {
    console.log("(dry run: nothing removed)");
    return 0;
  }
  if (!yes && !(await confirm("Take it down? [y/N] "))) {
    console.log(process.stdin.isTTY ? "Left as it is." : "Not a terminal: pass --yes to take it down."); // prettier-ignore
    return 1;
  }

  const message = removalMessage(id, entry.title, reason);
  const galleryCommit = removeFrom(GALLERY_REPO, id, message);
  if (galleryCommit)
    console.log(`Removed from ${GALLERY_REPO} (${galleryCommit.slice(0, 7)}).`);
  const submissionCommit = removeFrom(SUBMISSION_REPO, id, message);
  if (submissionCommit)
    console.log(`Removed from ${SUBMISSION_REPO} (${submissionCommit.slice(0, 7)}).`); // prettier-ignore
  if (galleryCommit)
    console.log(
      "\nThe gallery's validate workflow now dispatches the site deploy; the entry\n" +
        "leaves chiphippo.com/gallery when it finishes (a few minutes). Watch it:\n" +
        "  gh run list --repo jfigge/chiphippo --workflow deploy-site.yml --limit 1\n" +
        "Its files stay in the public repo's git history.",
    );
  return 0;
}

const USAGE = `usage:
  gallery-admin.mjs list
  gallery-admin.mjs delete <id> [--reason TEXT] [--dry-run] [--yes]`;

const IS_MAIN =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (IS_MAIN) {
  const [command, ...rest] = process.argv.slice(2);
  const args = [];
  const opts = { reason: undefined, dryRun: false, yes: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--reason") opts.reason = rest[++i]?.trim() || undefined;
    else if (rest[i] === "--dry-run") opts.dryRun = true;
    else if (rest[i] === "--yes") opts.yes = true;
    else args.push(rest[i]);
  }
  try {
    if (command === "list") list();
    else if (command === "delete" && args.length === 1)
      process.exitCode = await remove(args[0], opts);
    else {
      console.error(USAGE);
      process.exitCode = 2;
    }
  } catch (err) {
    console.error(`gallery-admin: ${err.message}`);
    process.exitCode = 1;
  }
}
