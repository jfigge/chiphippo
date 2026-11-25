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

// stores/github.js — a private store in a PRIVATE GITHUB REPOSITORY (the
// private stores work, .claude/rules/stores.md), and the account calls that
// set one up: the device-flow sign-in, making the repository, inviting a
// friend, and accepting an invitation on the friend's side so they never see
// GitHub's invitation page. sources.js says where each may go.
//
// The backend is the folder's three verbs — LIST, READ, ADD — over GitHub's
// REST API (a tree, a file's raw bytes, a file created), plus `readMany`, one
// GraphQL request for up to READ_BATCH small text files, since a store's
// listing reads every revision's meta and one request apiece would spend the
// hourly quota on one Browse. ADD never updates: no `sha` is sent, so GitHub
// itself refuses a path that exists (the append-only rule, enforced by the
// server). Every failure is CODED:
//   "noAccess"   — 404 on a private repository (not there, or not yours to see)
//   "signedOut"  — 401: the token was revoked or has expired
//   "rateLimited", "exists", "tooBig", "invalid", "unavailable".
"use strict";

const {
  GITHUB_REPO_RE,
  MAX_META_BYTES,
  githubDir,
  STORE_FILE,
  normalizeManifest,
  parseStorePath,
} = require("../../web/scripts/stores/store-format.js");
const { GITHUB_API, GITHUB_LOGIN, GITHUB_SCOPE } = require("./sources");

const TIMEOUT_MS = 20_000;
/** The most one JSON answer from GitHub may hold (a large store's tree). */
const MAX_JSON_BYTES = 8 * 1024 * 1024;
/** The small files one GraphQL request reads. */
const READ_BATCH = 50;
/** Who GitHub is told is asking (it requires a User-Agent). */
const USER_AGENT = "ChipHippo";

const coded = (code, message = code) => Object.assign(new Error(message), { code }); // prettier-ignore

/** A response's body, given up the moment it passes `max`. */
async function readCapped(res, max) {
  const length = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > max) throw coded("tooBig");
  const reader = res.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > max) throw coded("tooBig");
    return bytes;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      void reader.cancel().catch(() => {});
      throw coded("tooBig");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/** The code a GitHub status means. */
function codeFor(res) {
  if (res.status === 401) return "signedOut";
  if (res.status === 404) return "noAccess";
  if (res.status === 403 || res.status === 429) {
    // The primary limit spent (remaining 0), or a SECONDARY limit — which
    // GitHub answers with a retry-after and no zero count.
    const limited =
      res.status === 429 ||
      res.headers?.get?.("x-ratelimit-remaining") === "0" ||
      res.headers?.get?.("retry-after") != null;
    return limited ? "rateLimited" : "noAccess";
  }
  // 301/307: the repository was renamed or moved (redirects are refused, so
  // a token never follows one).
  if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) return "moved"; // prettier-ignore
  return "unavailable";
}

/** Is an answer to this Accept header JSON (and so to be parsed)? A RAW
    file's (`application/vnd.github.raw+json`) is the file's own bytes —
    a picture as much as a design — and never is. */
const isJsonAccept = (accept) =>
  accept === "application/json" || accept === "application/vnd.github+json";

/**
 * One request. `url` is built here from the hosts sources.js states, never
 * handed in. Answers `{status, bytes, json}`; a status outside `ok` throws
 * its code.
 */
async function request(
  url,
  { method = "GET", token = null, body = null, accept = "application/vnd.github+json", max = MAX_JSON_BYTES, ok = [200, 201, 204], fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS, form = false } = {}, // prettier-ignore
) {
  if (
    !url.startsWith(`${GITHUB_API}/`) &&
    !url.startsWith(`${GITHUB_LOGIN}/login/`)
  ) {
    throw coded("invalid", "not a GitHub address this app may reach");
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const headers = { accept, "user-agent": USER_AGENT };
  if (url.startsWith(GITHUB_API))
    headers["x-github-api-version"] = "2022-11-28";
  // The token goes to the API host ONLY — never the login host.
  if (token && url.startsWith(`${GITHUB_API}/`)) headers.authorization = `Bearer ${token}`; // prettier-ignore
  let payload;
  if (body != null) {
    if (form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      payload = new URLSearchParams(body).toString();
    } else {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
  }
  try {
    const res = await fetch(url, { method, headers, body: payload, signal: abort.signal, credentials: "omit", redirect: "manual" }); // prettier-ignore
    if (!ok.includes(res.status)) {
      const err = coded(codeFor(res), `GitHub answered ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const bytes = res.status === 204 ? Buffer.alloc(0) : await readCapped(res, max); // prettier-ignore
    let json = null;
    if (isJsonAccept(accept) && bytes.length) {
      try {
        json = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw coded("invalid", "GitHub's answer was not JSON");
      }
    }
    return { status: res.status, bytes, json };
  } catch (err) {
    if (err.code) throw err;
    throw coded("unavailable", err.message || "GitHub could not be reached");
  } finally {
    clearTimeout(timer);
  }
}

/** A repo-relative path as GitHub's contents URL spells it. */
const contentsUrl = (repo, rel) =>
  `${GITHUB_API}/repos/${repo}/contents/${rel.split("/").map(encodeURIComponent).join("/")}`; // prettier-ignore

class GitHubBackend {
  /**
   * @param {string} repo - `owner/name`.
   * @param {{token: () => string|null, fetch?: typeof fetch, dir?: string}}
   *   opts - `token` is read per request (credential-store's, never kept
   *   here); `dir` the folder in the repository the store lives in ("" — the
   *   root — for a repository Chip Hippo made; a folder of its own in one the
   *   user already had). Every store path is relative to it.
   */
  constructor(repo, { token, fetch = globalThis.fetch, dir = "" } = {}) {
    if (!GITHUB_REPO_RE.test(repo ?? "")) throw coded("invalid", "not a repository"); // prettier-ignore
    const clean = githubDir(dir);
    if (clean == null) throw coded("invalid", "not a folder name");
    this.repo = repo;
    this.dir = clean;
    this._token = token;
    this._fetch = fetch;
  }

  /** A store path as a path in the repository. */
  _full(rel) {
    return this.dir ? `${this.dir}/${rel}` : rel;
  }

  /** The tree the store's paths are listed from: the default branch's, or
      the store folder's own — asked of GraphQL by path (`HEAD:<dir>`), so
      a folder however deep, beside however many others, is found (a
      contents listing stops at 1,000 items). */
  async _tree() {
    if (!this.dir) return "HEAD";
    const [owner, name] = this.repo.split("/");
    const res = await this._req(`${GITHUB_API}/graphql`, {
      method: "POST",
      body: {
        query: `query($owner: String!, $name: String!, $expr: String!) { repository(owner: $owner, name: $name) { object(expression: $expr) { ... on Tree { oid } } } }`, // prettier-ignore
        variables: { owner, name, expr: `HEAD:${this.dir}` },
      },
    });
    const repo = res.json?.data?.repository;
    if (!repo) {
      const errors = Array.isArray(res.json?.errors) ? res.json.errors : [];
      if (errors.some((e) => e?.type === "RATE_LIMITED")) throw coded("rateLimited"); // prettier-ignore
      throw coded(errors.length ? "noAccess" : "unavailable");
    }
    const oid = repo.object?.oid;
    if (typeof oid !== "string" || !oid) throw coded("missing");
    return oid;
  }

  _req(url, opts = {}) {
    const token = this._token?.();
    if (!token) throw coded("signedOut");
    return request(url, { ...opts, token, fetch: this._fetch });
  }

  async manifest() {
    const bytes = await this.read(STORE_FILE, { max: 16 * 1024 });
    if (!bytes) return null;
    try {
      return normalizeManifest(JSON.parse(bytes.toString("utf8")));
    } catch {
      return null;
    }
  }

  /** Every store path in the repository's default branch. */
  async list() {
    let res;
    try {
      const tree = await this._tree();
      res = await this._req(`${GITHUB_API}/repos/${this.repo}/git/trees/${encodeURIComponent(tree)}?recursive=1`); // prettier-ignore
    } catch (err) {
      // 409: a repository with no commit yet — no store in it.
      if (err.status === 409) throw coded("missing");
      throw err;
    }
    // A listing GitHub cut short would hide revisions — and pick the wrong
    // head — so it is said rather than shown: the store should live in a
    // folder of its own (a repository Chip Hippo makes holds nothing else).
    if (res.json?.truncated === true) throw coded("tooLarge");
    const tree = Array.isArray(res.json?.tree) ? res.json.tree : [];
    const paths = tree
      .filter((t) => t?.type === "blob" && typeof t.path === "string")
      .map((t) => t.path)
      .filter((p) => p === STORE_FILE || parseStorePath(p));
    if (!paths.includes(STORE_FILE)) throw coded("missing");
    return paths;
  }

  /** One file's bytes, or null when it is not there. */
  async read(rel, { max }) {
    if (rel !== STORE_FILE && !parseStorePath(rel)) throw coded("invalid");
    try {
      const res = await this._req(contentsUrl(this.repo, this._full(rel)), { accept: "application/vnd.github.raw+json", max }); // prettier-ignore
      return res.bytes;
    } catch (err) {
      if (err.code === "noAccess" && err.status === 404) {
        // A file not there and a repository not there both answer 404; the
        // listing already proved the repository, so this is the file.
        return null;
      }
      throw err;
    }
  }

  /**
   * Many small TEXT files at once (entry.json and revision metas), through
   * GraphQL: `Map(rel → text)`, a file not there left out.
   */
  async readMany(rels) {
    const out = new Map();
    const [owner, name] = this.repo.split("/");
    const list = rels.filter((r) => r === STORE_FILE || parseStorePath(r));
    // A batch that fails ends the read with a throw — never a partial map
    // passed off as the store (a missing meta could make an older revision
    // look like the head, and a save from it a fork nobody was asked
    // about). What arrived before it rides the throw (`err.partial`), so
    // the caller can keep it and ask only for the rest next time.
    try {
      for (let i = 0; i < list.length; i += READ_BATCH) {
        const chunk = list.slice(i, i + READ_BATCH);
        const fields = chunk
          .map(
            (rel, k) =>
              `f${k}: object(expression: ${JSON.stringify(`HEAD:${this._full(rel)}`)}) { ... on Blob { text byteSize isBinary } }`,
          ) // prettier-ignore
          .join(" ");
        const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`; // prettier-ignore
        const res = await this._req(`${GITHUB_API}/graphql`, {
          method: "POST",
          body: { query, variables: { owner, name } },
        });
        const repo = res.json?.data?.repository;
        const errors = Array.isArray(res.json?.errors) ? res.json.errors : [];
        if (errors.some((e) => e?.type === "RATE_LIMITED")) throw coded("rateLimited"); // prettier-ignore
        if (!repo) throw coded(errors.length ? "noAccess" : "unavailable");
        // Errors beside the data (a field GitHub could not answer): this
        // batch is not whole, and a meta quietly missing could pick the
        // wrong head — so it fails like any other batch.
        if (errors.length) throw coded("unavailable");
        chunk.forEach((rel, k) => {
          const blob = repo[`f${k}`];
          if (blob && !blob.isBinary && typeof blob.text === "string" && blob.byteSize <= MAX_META_BYTES) {
            out.set(rel, blob.text);
          }
        }); // prettier-ignore
      }
    } catch (err) {
      err.partial = out;
      throw err;
    }
    return out;
  }

  /** Add one file — a commit of its own; a path already there is "exists". */
  async add(rel, data, { message = `Add ${rel}` } = {}) {
    if (rel !== STORE_FILE && !parseStorePath(rel)) throw coded("invalid");
    const content = Buffer.from(data).toString("base64");
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this._req(contentsUrl(this.repo, this._full(rel)), {
          method: "PUT",
          body: { message, content },
          ok: [200, 201],
        });
        return true;
      } catch (err) {
        // 422: GitHub wants a `sha` — the file is there already.
        if (err.status === 422) throw coded("exists");
        // 409: the branch moved under this commit (a friend's save landed
        // between) — once more, on the new head.
        if (err.status === 409 && attempt < 2) continue;
        throw err;
      }
    }
  }
}

// ── The account ──────────────────────────────────────────────────────────────

/**
 * Begin the device-flow sign-in: `{deviceCode, userCode, verificationUri,
 * expiresIn, interval}` — the user types `userCode` at `verificationUri`.
 */
async function startDeviceFlow({ clientId, fetch = globalThis.fetch }) {
  if (!clientId) throw coded("notConfigured");
  const { json } = await request(`${GITHUB_LOGIN}/login/device/code`, {
    method: "POST",
    form: true,
    body: { client_id: clientId, scope: GITHUB_SCOPE },
    accept: "application/json",
    fetch,
  });
  if (typeof json?.device_code !== "string" || typeof json?.user_code !== "string") {
    throw coded("unavailable", "GitHub gave no sign-in code");
  } // prettier-ignore
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    // Always GitHub's own device page, whatever the answer named.
    verificationUri: `${GITHUB_LOGIN}/login/device`,
    expiresIn: Number(json.expires_in) || 900,
    interval: Math.max(5, Number(json.interval) || 5),
  };
}

/**
 * Ask once whether the user has entered the code: `{token}` when they have,
 * `{pending: true, interval?}` while they have not, or a throw — "denied"
 * (they pressed Cancel), "expired" (too late; begin again).
 */
async function pollDeviceFlow({
  clientId,
  deviceCode,
  fetch = globalThis.fetch,
}) {
  const { json } = await request(`${GITHUB_LOGIN}/login/oauth/access_token`, {
    method: "POST",
    form: true,
    body: {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
    accept: "application/json",
    fetch,
  });
  if (typeof json?.access_token === "string" && json.access_token) {
    return { token: json.access_token, ...expiryOf(json) };
  }
  switch (json?.error) {
    case "authorization_pending":
      return { pending: true };
    case "slow_down":
      return { pending: true, interval: Number(json.interval) || 10 };
    case "access_denied":
      throw coded("denied");
    case "expired_token":
      throw coded("expired");
    default:
      throw coded("unavailable", json?.error || "the sign-in failed");
  }
}

/**
 * What an access-token answer says about expiry. An OAuth App with "Expire
 * user access tokens" on hands back an 8-hour token with a refresh token
 * (6 months); one without, a token that never expires (no fields at all).
 * Lifetimes in SECONDS, as GitHub states them: the caller turns them into
 * times on its own clock.
 */
function expiryOf(json) {
  const out = {};
  if (typeof json?.refresh_token === "string" && json.refresh_token) out.refreshToken = json.refresh_token; // prettier-ignore
  const life = Number(json?.expires_in);
  if (life > 0) out.expiresIn = life;
  const refreshLife = Number(json?.refresh_token_expires_in);
  if (refreshLife > 0) out.refreshExpiresIn = refreshLife;
  return out;
}

/**
 * Trade a refresh token for a new access token (and a new refresh token:
 * GitHub rotates them, so the old pair stops working). A device-flow token
 * is refreshed WITHOUT the client secret, which is why the flow fits a
 * desktop app that ships none. A refresh token GitHub no longer takes is
 * "signedOut" (sign in again).
 */
async function refreshAccessToken({
  clientId,
  refreshToken,
  fetch = globalThis.fetch,
}) {
  const { json } = await request(`${GITHUB_LOGIN}/login/oauth/access_token`, {
    method: "POST",
    form: true,
    body: {
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    accept: "application/json",
    fetch,
  });
  if (typeof json?.access_token === "string" && json.access_token) {
    return { token: json.access_token, ...expiryOf(json) };
  }
  // GitHub ANSWERED and refused (a spent or revoked refresh token, or one
  // it wants more for): signed out — never a sign-in that looks alive and
  // fails every request. Only no answer at all is worth asking again.
  if (typeof json?.error === "string" && json.error) throw coded("signedOut", json.error); // prettier-ignore
  throw coded("unavailable", "the refresh failed");
}

/** Who the token belongs to: `{login}`. */
async function whoAmI({ token, fetch = globalThis.fetch }) {
  const { json } = await request(`${GITHUB_API}/user`, { token, fetch });
  if (typeof json?.login !== "string") throw coded("invalid");
  return { login: json.login };
}

const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** A store's name as a repository name: GitHub's characters, never empty. */
function repoNameFor(name) {
  const clean = String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return clean && clean !== "." && clean !== ".." ? clean : "chiphippo-designs";
}

/**
 * Make a PRIVATE repository on the signed-in account: `{repo}` (`owner/name`).
 * A name already taken is tried with `-2`, `-3`… (at most a few).
 */
async function createRepo({
  token,
  name,
  description = "",
  fetch = globalThis.fetch,
}) {
  const base = repoNameFor(name);
  for (let n = 1; n <= 5; n += 1) {
    const repoName = n === 1 ? base : `${base}-${n}`;
    if (!REPO_NAME_RE.test(repoName)) throw coded("invalid");
    try {
      const { json } = await request(`${GITHUB_API}/user/repos`, {
        method: "POST",
        token,
        fetch,
        body: { name: repoName, description, private: true, has_issues: false, has_wiki: false, has_projects: false }, // prettier-ignore
        ok: [201],
      });
      if (!GITHUB_REPO_RE.test(json?.full_name ?? "")) throw coded("invalid");
      if (json.private !== true) throw coded("notPrivate");
      return { repo: json.full_name };
    } catch (err) {
      if (err.status === 422 && n < 5) continue; // the name is taken
      throw err;
    }
  }
  throw coded("nameTaken");
}

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** How many pages of repositories the picker reads (100 a page). */
const REPO_PAGES = 3;

/**
 * The PRIVATE repositories the signed-in account can write to — its own,
 * its organizations', and the ones it collaborates on — most recently
 * changed first: what "Use one of my repositories" offers. A public one is
 * never offered: a store in it would publish every design.
 * @returns {Promise<{repos: {repo: string}[]}>}
 */
async function listRepos({ token, fetch = globalThis.fetch }) {
  const repos = [];
  for (let page = 1; page <= REPO_PAGES; page += 1) {
    const { json } = await request(
      `${GITHUB_API}/user/repos?per_page=100&page=${page}&sort=updated&visibility=private&affiliation=owner,collaborator,organization_member`, // prettier-ignore
      { token, fetch },
    );
    const list = Array.isArray(json) ? json : [];
    for (const r of list) {
      if (
        r?.private === true &&
        r.permissions?.push === true &&
        GITHUB_REPO_RE.test(r.full_name ?? "")
      ) {
        // prettier-ignore
        repos.push({ repo: r.full_name });
      }
    }
    if (list.length < 100) break;
  }
  return { repos };
}

/** Whether `repo` is private, and whether the account can write to it. */
async function repoAccess({ token, repo, fetch = globalThis.fetch }) {
  if (!GITHUB_REPO_RE.test(repo ?? "")) throw coded("invalid");
  const { json } = await request(`${GITHUB_API}/repos/${repo}`, { token, fetch }); // prettier-ignore
  return { private: json?.private === true, push: json?.permissions?.push === true }; // prettier-ignore
}

/**
 * Invite `login` to the repository with write access: "invited" (an
 * invitation went), "already" (they are in), or a throw — "noUser".
 */
async function inviteFriend({ token, repo, login, fetch = globalThis.fetch }) {
  if (!GITHUB_REPO_RE.test(repo ?? "")) throw coded("invalid");
  if (!LOGIN_RE.test(login ?? "")) throw coded("badLogin");
  try {
    const { status } = await request(`${GITHUB_API}/repos/${repo}/collaborators/${login}`, {
      method: "PUT",
      token,
      fetch,
      body: { permission: "push" },
      ok: [201, 204],
    }); // prettier-ignore
    return status === 201 ? "invited" : "already";
  } catch (err) {
    if (err.status === 404) throw coded("noUser");
    if (err.status === 422) throw coded("noUser");
    throw err;
  }
}

/**
 * On the FRIEND's side: accept a waiting invitation to `repo`, so they never
 * have to find GitHub's invitation page. "accepted", "none" (no invitation
 * waiting — not invited yet, or already in).
 */
async function acceptInvitation({ token, repo, fetch = globalThis.fetch }) {
  const { json } = await request(`${GITHUB_API}/user/repository_invitations?per_page=100`, { token, fetch }); // prettier-ignore
  const want = String(repo).toLowerCase();
  const invite = (Array.isArray(json) ? json : []).find(
    (i) => String(i?.repository?.full_name ?? "").toLowerCase() === want && Number.isInteger(i?.id), // prettier-ignore
  );
  if (!invite) return "none";
  await request(`${GITHUB_API}/user/repository_invitations/${invite.id}`, {
    method: "PATCH",
    token,
    fetch,
    ok: [204],
  });
  return "accepted";
}

/**
 * Who can reach the store: `{people: [{login, pending}]}` — the
 * collaborators, then the invitations still waiting.
 */
async function storePeople({ token, repo, fetch = globalThis.fetch }) {
  if (!GITHUB_REPO_RE.test(repo ?? "")) throw coded("invalid");
  const [collab, invites] = await Promise.all([
    request(`${GITHUB_API}/repos/${repo}/collaborators?per_page=100`, { token, fetch }), // prettier-ignore
    request(`${GITHUB_API}/repos/${repo}/invitations?per_page=100`, { token, fetch }).catch(() => ({ json: [] })), // prettier-ignore
  ]);
  const people = [];
  for (const c of Array.isArray(collab.json) ? collab.json : []) {
    if (LOGIN_RE.test(c?.login ?? "")) people.push({ login: c.login, pending: false }); // prettier-ignore
  }
  for (const i of Array.isArray(invites.json) ? invites.json : []) {
    const login = i?.invitee?.login;
    if (LOGIN_RE.test(login ?? "") && !people.some((p) => p.login === login)) people.push({ login, pending: true }); // prettier-ignore
  }
  return { people };
}

module.exports = {
  GitHubBackend,
  LOGIN_RE,
  READ_BATCH,
  acceptInvitation,
  createRepo,
  inviteFriend,
  listRepos,
  pollDeviceFlow,
  refreshAccessToken,
  repoAccess,
  repoNameFor,
  request,
  startDeviceFlow,
  storePeople,
  whoAmI,
};
