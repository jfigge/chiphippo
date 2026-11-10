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

// github.js — the submission service's GitHub calls, on ONE repo (the
// private chiphippo-gallery-submission), with a fine-grained token that can
// write contents and pull requests there and nowhere else.
//
// A share is one commit on a branch of its own (`share/<id>`), made without
// a checkout through the Git Data API: a tree over main's with the entry's
// two files, a commit on it, the branch, then the pull request — and when the
// pull request can't be opened, the branch is deleted again.

const API = "https://api.github.com";

/** A GitHub error a caller can tell apart: `exists` (the branch is there). */
const failed = (what, status, code) =>
  Object.assign(new Error(`${what}: GitHub answered ${status}`), { status, code }); // prettier-ignore

/**
 * @param {{token: string, repo: string, fetch?: typeof fetch, api?: string}} opts
 */
export function makeGitHub({
  token,
  repo,
  fetch = globalThis.fetch,
  api = API,
}) {
  const call = async (method, path, body) => {
    const res = await fetch(`${api}/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "chiphippo-gallery-share",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
  const must = ({ status, data }, what) => {
    if (status >= 200 && status < 300) return data;
    throw failed(what, status);
  };
  const owner = repo.split("/")[0];
  /** Delete a share's branch; one already gone is as good. */
  const dropBranch = async (branch) => {
    const res = await call("DELETE", `/git/refs/heads/${branch}`);
    if (res.status !== 404 && res.status !== 422) must(res, "delete ref");
  };

  return {
    /** How many pull requests are open (up to 100 — the cap is below that). */
    async openPullCount() {
      const list = must(await call("GET", "/pulls?state=open&per_page=100"), "pulls"); // prettier-ignore
      return Array.isArray(list) ? list.length : 0;
    },

    /**
     * Has this share been made already — its pull request still OPEN, or its
     * entry on main (accepted)? A `share/<id>` branch with no open pull
     * request is a leftover (its pull request could not be opened, before
     * `openShare` cleaned up after itself; a closed one's is deleted by the
     * submission repo's tidy workflow), so it is deleted here and the share
     * may go ahead — never "already waiting" for a review that isn't.
     */
    async alreadyShared({ branch, entryPath }) {
      const ref = await call("GET", `/git/ref/heads/${branch}`);
      if (ref.status !== 404) {
        must(ref, "ref");
        const head = encodeURIComponent(`${owner}:${branch}`);
        const open = must(await call("GET", `/pulls?state=open&head=${head}&per_page=1`), "pulls"); // prettier-ignore
        if (Array.isArray(open) && open.length) return true;
        await dropBranch(branch);
      }
      const onMain = await call("GET", `/contents/${entryPath}?ref=main`);
      if (onMain.status === 404) return false;
      must(onMain, "contents");
      return true;
    },

    /**
     * Commit `files` (path → text) on a new branch off main and open a pull
     * request for it.
     * @returns {Promise<{number: number}>}
     */
    async openShare({ branch, files, message, title, body }) {
      const head = must(await call("GET", "/git/ref/heads/main"), "main");
      const base = must(await call("GET", `/git/commits/${head.object.sha}`), "commit"); // prettier-ignore
      const tree = must(
        await call("POST", "/git/trees", {
          base_tree: base.tree.sha,
          tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })), // prettier-ignore
        }),
        "tree",
      );
      const commit = must(
        await call("POST", "/git/commits", { message, tree: tree.sha, parents: [head.object.sha] }), // prettier-ignore
        "commit",
      );
      const ref = await call("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: commit.sha }); // prettier-ignore
      if (ref.status === 422) throw failed("ref", 422, "exists");
      must(ref, "ref");
      const pull = await call("POST", "/pulls", {
        title,
        head: branch,
        base: "main",
        body,
      });
      if (pull.status < 200 || pull.status >= 300) {
        // No pull request, so no branch: left behind, it would answer every
        // retry of this share "already waiting for review" for good.
        await dropBranch(branch).catch(() => {});
        throw failed("pull", pull.status);
      }
      return { number: pull.data.number };
    },

    /**
     * One pull request's state and its comments, oldest first — or null when
     * there is no such pull request.
     * @returns {Promise<{open: boolean, merged: boolean, head: string|null,
     *   comments: {author: string|null, body: string}[]}|null>}
     */
    async pullStatus(number) {
      const res = await call("GET", `/pulls/${number}`);
      if (res.status === 404) return null;
      const pull = must(res, "pull");
      const list = must(await call("GET", `/issues/${number}/comments?per_page=100`), "comments"); // prettier-ignore
      return {
        open: pull.state === "open",
        merged: Boolean(pull.merged_at),
        head: pull.head?.ref ?? null,
        comments: (Array.isArray(list) ? list : []).map((c) => ({
          author: c?.user?.login ?? null,
          body: typeof c?.body === "string" ? c.body : "",
        })),
      };
    },
  };
}
