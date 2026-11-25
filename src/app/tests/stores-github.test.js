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

// A private store in a GitHub repository (app/stores/github.js) against a
// fake GitHub: the device-flow sign-in, making the repository, inviting and
// accepting, and the store's own list/read/add — the same service as a
// folder store drives (app/stores/service.js).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  GitHubBackend,
  acceptInvitation,
  createRepo,
  inviteFriend,
  listRepos,
  pollDeviceFlow,
  repoAccess,
  repoNameFor,
  request,
  startDeviceFlow,
  storePeople,
  whoAmI,
} = require("../stores/github");
const { githubClientId, guidePage, repoPage } = require("../stores/sources");
const { StoreService } = require("../stores/service");
const { makeManifest } = require("../../web/scripts/stores/store-format.js");

const ID = "s-0123456789abcdef";
const TOKEN = "gho_annstoken";

const reply = (status, body) =>
  new Response(body == null ? null : typeof body === "string" ? body : JSON.stringify(body), { status }); // prettier-ignore

/** A GitHub that knows one user, their repositories and their files. */
function fakeGitHub() {
  const gh = {
    repos: new Map(), // full_name → Map(path → Buffer)
    public: new Set(),
    invites: [],
    collaborators: new Map(),
    calls: [],
    polls: 0,
    // Expiring tokens ("Expire user access tokens" on the OAuth App): each
    // issue is an access token valid until the next refresh, and a
    // single-use refresh token.
    expiring: false,
    refreshes: 0,
    valid: new Set([TOKEN]),
    refreshTokens: new Map(),
  };
  gh.issue = (n) => {
    const access = `tok-${n}`;
    gh.valid = new Set([TOKEN, access]);
    if (n > 0) gh.valid.delete(`tok-${n - 1}`);
    gh.refreshTokens.set(`ref-${n}`, n);
    return { access_token: access, expires_in: 28800, refresh_token: `ref-${n}`, refresh_token_expires_in: 15897600 }; // prettier-ignore
  };
  gh.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const auth = init.headers?.authorization;
    gh.calls.push({ url, method, auth });
    const u = new URL(url);
    if (u.host === "github.com") {
      assert.equal(auth, undefined, "a token never goes to the login host");
      const form = new URLSearchParams(init.body);
      if (u.pathname === "/login/device/code") {
        assert.equal(form.get("scope"), "repo");
        return reply(200, { device_code: "dev123", user_code: "ABCD-1234", verification_uri: "https://evil.example/", expires_in: 900, interval: 5 }); // prettier-ignore
      }
      if (
        u.pathname === "/login/oauth/access_token" &&
        form.get("grant_type") === "refresh_token"
      ) {
        // prettier-ignore
        // Rotation: each refresh token works once, for a new pair.
        gh.refreshes += 1;
        const n = gh.refreshTokens.get(form.get("refresh_token"));
        if (n == null) return reply(200, { error: "bad_refresh_token" });
        gh.refreshTokens.delete(form.get("refresh_token"));
        return reply(200, gh.issue(n + 1));
      }
      if (u.pathname === "/login/oauth/access_token") {
        gh.polls += 1;
        if (gh.polls < 2) return reply(200, { error: "authorization_pending" });
        return reply(200, gh.expiring ? gh.issue(0) : { access_token: TOKEN });
      }
    }
    if (!gh.valid.has(auth?.slice(7))) return reply(401, { message: "Bad credentials" }); // prettier-ignore
    const p = u.pathname;
    if (p === "/user") return reply(200, { login: "ann" });
    if (p === "/user/repos" && method === "GET") {
      return reply(200, [...gh.repos.keys()].map((full_name) => ({ full_name, private: !gh.public.has(full_name), permissions: { push: true } })).concat([{ full_name: "someone/read-only", private: true, permissions: { push: false } }])); // prettier-ignore
    }
    const whole = /^\/repos\/([^/]+\/[^/]+)$/.exec(p);
    if (whole) {
      if (!gh.repos.has(whole[1])) return reply(404, {});
      return reply(200, { full_name: whole[1], private: !gh.public.has(whole[1]), permissions: { push: true } }); // prettier-ignore
    }
    if (p === "/user/repos" && method === "POST") {
      const body = JSON.parse(init.body);
      const full = `ann/${body.name}`;
      if (gh.repos.has(full)) return reply(422, { message: "name already exists" }); // prettier-ignore
      gh.repos.set(full, new Map());
      return reply(201, { full_name: full, private: body.private });
    }
    if (p === "/graphql") {
      const { query, variables } = JSON.parse(init.body);
      const files = gh.repos.get(`${variables.owner}/${variables.name}`);
      if (!files)
        return reply(200, { data: { repository: null }, errors: [{}] });
      const repository = {};
      // A folder asked for by path (`HEAD:<dir>`): its tree's oid.
      if (variables.expr) {
        const dir = variables.expr.slice(5);
        const any = [...files.keys()].some((f) => f.startsWith(`${dir}/`));
        repository.object = any ? { oid: `tree:${dir}` } : null;
        return reply(200, { data: { repository } });
      }
      for (const [, alias, rel] of query.matchAll(
        /(f\d+): object\(expression: "HEAD:([^"]+)"\)/g,
      )) {
        // prettier-ignore
        const b = files.get(rel);
        repository[alias] = b ? { text: b.toString("utf8"), byteSize: b.length, isBinary: false } : null; // prettier-ignore
      }
      return reply(200, { data: { repository } });
    }
    let m = /^\/repos\/([^/]+\/[^/]+)\/(.*)$/.exec(p);
    if (!m) return reply(404, {});
    const [, repo, rest] = m;
    const files = gh.repos.get(repo);
    if (!files) return reply(404, { message: "Not Found" });
    if (rest === "git/trees/HEAD") {
      if (!files.size) return reply(409, { message: "Git Repository is empty." }); // prettier-ignore
      return reply(200, { tree: [...files.keys()].map((path) => ({ path, type: "blob" })) }); // prettier-ignore
    }
    // A folder's own tree, by the sha its parent's listing gave ("tree:<path>").
    if (rest.startsWith("git/trees/tree%3A")) {
      const dir = decodeURIComponent(rest.slice("git/trees/".length)).slice(5);
      return reply(200, { tree: [...files.keys()].filter((f) => f.startsWith(`${dir}/`)).map((f) => ({ path: f.slice(dir.length + 1), type: "blob" })) }); // prettier-ignore
    }
    // A folder's listing (the repository's root for "contents/").
    if (
      method === "GET" &&
      (rest === "contents/" || rest.startsWith("contents/"))
    ) {
      const at = rest.slice("contents/".length).split("/").map(decodeURIComponent).join("/"); // prettier-ignore
      const prefix = at ? `${at}/` : "";
      const under = [...files.keys()].filter((f) => f.startsWith(prefix));
      if (!files.has(at) && under.length && !under.includes(at)) {
        if (!files.size) return reply(404, {});
        const kids = new Map();
        for (const f of under) {
          const [head, ...more] = f.slice(prefix.length).split("/");
          kids.set(head, more.length ? { type: "dir", name: head, sha: `tree:${prefix}${head}` } : { type: "file", name: head }); // prettier-ignore
        }
        return reply(200, [...kids.values()]);
      }
      if (at === "" && !files.size) return reply(404, { message: "This repository is empty." }); // prettier-ignore
    }
    if ((m = /^contents\/(.+)$/.exec(rest))) {
      const rel = m[1].split("/").map(decodeURIComponent).join("/");
      // The raw media type answers the file's own bytes — a PNG as much as
      // a design (JSON-parsing it was the thumbnail bug).
      if (method === "GET") return files.has(rel) ? new Response(files.get(rel), { status: 200 }) : reply(404, {}); // prettier-ignore
      if (method === "PUT") {
        if (files.has(rel))
          return reply(422, { message: "sha wasn't supplied" });
        files.set(rel, Buffer.from(JSON.parse(init.body).content, "base64"));
        return reply(201, {});
      }
    }
    if ((m = /^collaborators\/([^/]+)$/.exec(rest)) && method === "PUT") {
      if (m[1] === "nobody") return reply(404, {});
      if (gh.collaborators.get(repo)?.has(m[1])) return reply(204);
      gh.invites.push({ id: gh.invites.length + 1, repository: { full_name: repo }, invitee: { login: m[1] } }); // prettier-ignore
      return reply(201, {});
    }
    if (rest === "collaborators") return reply(200, [...(gh.collaborators.get(repo) ?? [])].map((login) => ({ login }))); // prettier-ignore
    if (rest === "invitations") return reply(200, gh.invites.filter((i) => i.repository.full_name === repo)); // prettier-ignore
    return reply(404, {});
  };
  return gh;
}

test("the sign-in is GitHub's device flow, and its page is always GitHub's own", async () => {
  const gh = fakeGitHub();
  await assert.rejects(startDeviceFlow({ clientId: "", fetch: gh.fetch }), { code: "notConfigured" }); // prettier-ignore
  const flow = await startDeviceFlow({ clientId: "Iv1.abcdef0123", fetch: gh.fetch }); // prettier-ignore
  assert.equal(flow.userCode, "ABCD-1234");
  assert.equal(flow.verificationUri, "https://github.com/login/device");
  assert.deepEqual(await pollDeviceFlow({ clientId: "Iv1.abcdef0123", deviceCode: flow.deviceCode, fetch: gh.fetch }), { pending: true }); // prettier-ignore
  const done = await pollDeviceFlow({ clientId: "Iv1.abcdef0123", deviceCode: flow.deviceCode, fetch: gh.fetch }); // prettier-ignore
  assert.equal(done.token, TOKEN);
  assert.deepEqual(await whoAmI({ token: TOKEN, fetch: gh.fetch }), { login: "ann" }); // prettier-ignore
});

test("a store's repository is made private, named for the store, and found free", async () => {
  const gh = fakeGitHub();
  assert.equal(repoNameFor("Bench club ⚡ 2026"), "Bench-club-2026");
  assert.equal(repoNameFor("..."), "chiphippo-designs");
  const { repo } = await createRepo({ token: TOKEN, name: "Bench club", fetch: gh.fetch }); // prettier-ignore
  assert.equal(repo, "ann/Bench-club");
  const second = await createRepo({ token: TOKEN, name: "Bench club", fetch: gh.fetch }); // prettier-ignore
  assert.equal(second.repo, "ann/Bench-club-2");
});

test("inviting a friend, and the friend's app accepting it for them", async () => {
  const gh = fakeGitHub();
  const { repo } = await createRepo({ token: TOKEN, name: "Lab", fetch: gh.fetch }); // prettier-ignore
  assert.equal(await inviteFriend({ token: TOKEN, repo, login: "bob", fetch: gh.fetch }), "invited"); // prettier-ignore
  await assert.rejects(inviteFriend({ token: TOKEN, repo, login: "nobody", fetch: gh.fetch }), { code: "noUser" }); // prettier-ignore
  await assert.rejects(inviteFriend({ token: TOKEN, repo, login: "bad name!", fetch: gh.fetch }), { code: "badLogin" }); // prettier-ignore
  const people = await storePeople({ token: TOKEN, repo, fetch: gh.fetch });
  assert.deepEqual(people.people, [{ login: "bob", pending: true }]);
  // The friend's side: their waiting invitations (the fake lists everyone's
  // — enough to see the accept find this repository's and answer it).
  const original = gh.fetch;
  const fetch = async (url, init) => {
    if (url.includes("/user/repository_invitations?")) return reply(200, gh.invites); // prettier-ignore
    if (/\/user\/repository_invitations\/\d+$/.test(url)) return reply(204);
    return original(url, init);
  };
  assert.equal(await acceptInvitation({ token: TOKEN, repo: repo.toUpperCase(), fetch }), "accepted"); // prettier-ignore
  assert.equal(await acceptInvitation({ token: TOKEN, repo: "ann/other", fetch }), "none"); // prettier-ignore
});

test("a GitHub store through the service: one GraphQL read for every meta, and no write over", async () => {
  const gh = fakeGitHub();
  const { repo } = await createRepo({ token: TOKEN, name: "Lab", fetch: gh.fetch }); // prettier-ignore
  const backend = new GitHubBackend(repo, {
    token: () => TOKEN,
    fetch: gh.fetch,
  });
  await assert.rejects(backend.list(), { code: "missing" });
  await backend.add("chiphippo-store.json", JSON.stringify(makeManifest({ id: ID, name: "Lab" }))); // prettier-ignore
  const store = { id: ID, name: "Lab", kind: "github", where: { repo } };
  const clock = { t: Date.UTC(2026, 10, 22, 10, 0, 0) };
  const service = new StoreService({
    backendFor: () => backend,
    sha256Hex: (d) => crypto.createHash("sha256").update(d).digest("hex"),
    randomHex: (n) => crypto.randomBytes(n).toString("hex"),
    now: () => clock.t,
  });
  const fields = { title: "Gates", author: "Ann", description: "", tags: [] };
  const app = { appVersion: "1.6.0", docVersion: 15 };
  for (let n = 0; n < 3; n += 1) {
    clock.t += 1000;
    await service.save(store, { design: JSON.stringify({ kind: "desktop", n, doc: {} }), fields: { ...fields, title: `Gates ${n}` }, app }); // prettier-ignore
  }
  gh.calls.length = 0;
  const fresh = new StoreService({ backendFor: () => backend, sha256Hex: () => "0".repeat(64), randomHex: () => "000000" }); // prettier-ignore
  const view = await fresh.view(store);
  assert.equal(view.entries.length, 3);
  // The tree, then ONE GraphQL request for the manifest, 3 entries, 3 metas.
  assert.deepEqual(gh.calls.map((c) => new URL(c.url).pathname), [`/repos/${repo}/git/trees/HEAD`, "/graphql"]); // prettier-ignore
  // Read again: only the tree — every file seen is kept.
  gh.calls.length = 0;
  await fresh.view(store);
  assert.equal(gh.calls.length, 1);
  await assert.rejects(backend.add("chiphippo-store.json", "{}"), { code: "exists" }); // prettier-ignore
  // Signed out: the token is gone, nothing is sent.
  const out = new GitHubBackend(repo, { token: () => null, fetch: gh.fetch });
  await assert.rejects(out.list(), { code: "signedOut" });
  // A repository you cannot see answers as no access.
  const elsewhere = new GitHubBackend("bob/secret", { token: () => TOKEN, fetch: gh.fetch }); // prettier-ignore
  await assert.rejects(elsewhere.list(), { code: "noAccess" });
});

test("the client id, the guide's pages and a repository's pages are stated here", () => {
  assert.equal(githubClientId({ devClientId: "Iv1.devclient01" }), "Iv1.devclient01"); // prettier-ignore
  assert.equal(githubClientId({ devClientId: "bad id with spaces" }), githubClientId()); // prettier-ignore
  assert.equal(githubClientId(), "Ov23lixgbUNY4hbDuwEo", "the registered app");
  assert.equal(guidePage("github-signup"), "https://github.com/signup");
  assert.equal(guidePage("https://evil.example"), null);
  assert.equal(guidePage("__proto__"), null);
  assert.equal(repoPage("ann/lab", { access: true }), "https://github.com/ann/lab/settings/access"); // prettier-ignore
  assert.equal(repoPage("../x"), null);
});

test("a store in a FOLDER of a repository the user already had: listed, read and written there only", async () => {
  const gh = fakeGitHub();
  const { repo } = await createRepo({ token: TOKEN, name: "website", fetch: gh.fetch }); // prettier-ignore
  // What the repository already held.
  gh.repos.get(repo).set("index.html", Buffer.from("<html>"));
  gh.repos.get(repo).set("docs/readme.md", Buffer.from("# hi"));
  const backend = new GitHubBackend(repo, { token: () => TOKEN, fetch: gh.fetch, dir: "chiphippo" }); // prettier-ignore
  assert.throws(() => new GitHubBackend(repo, { token: () => TOKEN, dir: "../x" }), { code: "invalid" }); // prettier-ignore
  await assert.rejects(backend.list(), { code: "missing" });
  await backend.add("chiphippo-store.json", JSON.stringify(makeManifest({ id: ID, name: "Lab" }))); // prettier-ignore
  assert.ok(gh.repos.get(repo).has("chiphippo/chiphippo-store.json"));
  const store = { id: ID, name: "Lab", kind: "github", where: { repo, dir: "chiphippo" } }; // prettier-ignore
  const service = new StoreService({
    backendFor: () => backend,
    sha256Hex: (d) => crypto.createHash("sha256").update(d).digest("hex"),
    randomHex: (n) => crypto.randomBytes(n).toString("hex"),
  });
  const saved = await service.save(store, { design: JSON.stringify({ kind: "desktop", doc: {} }), fields: { title: "Gates", author: "Ann", description: "", tags: [] }, app: {} }); // prettier-ignore
  // Everything the store wrote is under its folder; nothing else was touched.
  const paths = [...gh.repos.get(repo).keys()];
  assert.deepEqual(paths.filter((p) => !p.startsWith("chiphippo/")), ["index.html", "docs/readme.md"]); // prettier-ignore
  const view = await new StoreService({ backendFor: () => backend, sha256Hex: () => "0".repeat(64), randomHex: () => "000000" }).view(store); // prettier-ignore
  assert.equal(view.entries.length, 1);
  assert.equal(view.entries[0].id, saved.entry);
});

test("the picker offers only private repositories the account can write to", async () => {
  const gh = fakeGitHub();
  await createRepo({ token: TOKEN, name: "secret", fetch: gh.fetch });
  const { repo: open } = await createRepo({ token: TOKEN, name: "open", fetch: gh.fetch }); // prettier-ignore
  gh.public.add(open);
  const { repos } = await listRepos({ token: TOKEN, fetch: gh.fetch });
  assert.deepEqual(repos, [{ repo: "ann/secret" }]);
  assert.deepEqual(await repoAccess({ token: TOKEN, repo: open, fetch: gh.fetch }), { private: false, push: true }); // prettier-ignore
  assert.equal(repoPage("ann/site", { dir: "chiphippo" }), "https://github.com/ann/site/tree/HEAD/chiphippo"); // prettier-ignore
});

/** Main's store handlers over a fake GitHub, signed in (or not). */
function mainWith(
  gh,
  { signedIn = true, clientId = "Iv1.testclient0", clock = Date.now } = {},
) {
  const { registerStoresIpc } = require("../ipc/stores");
  const handlers = new Map();
  const settings = {};
  const mainWc = {};
  const creds = { token: signedIn ? TOKEN : null };
  registerStoresIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    dialog: {},
    shell: {},
    enabled: () => true,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: mainWc }),
    getBrowseWindow: () => null,
    getSettingsStore: () => ({ get: () => ({ ...settings }), set: (p) => Object.assign(settings, p) }), // prettier-ignore
    getBookmarks: () => ({ withAccess: (_p, fn) => fn() }),
    getCredentialStore: () => ({
      available: () => true,
      keyFor: () => creds.token,
      set: (_k, value) => ((creds.token = value), { ok: true }),
      clear: () => (creds.token = null),
    }),
    getProjectStore: () => ({ buildDesktopSnapshot: (x) => ({ version: 5, kind: "desktop", ...x }) }), // prettier-ignore
    prepareShare: require("../gallery/gate").prepareShare,
    plainImages: (i) => i,
    captureRect: async () => null,
    sendToMain: () => {},
    showMainWindow: () => {},
    m: (_k, fallback) => fallback,
    appVersion: () => "1.6.0",
    docVersion: 15,
    fetch: gh.fetch,
    devClientId: clientId,
    sleep: async () => {},
    clock: () => clock(),
  });
  const call = (ch, ...args) => handlers.get(ch)({ sender: mainWc }, ...args);
  return { call, settings, creds };
}

test("the GitHub sign-in through main: one at a time, the token kept, a superseded press stands down", async () => {
  const gh = fakeGitHub();
  const { call, settings, creds } = mainWith(gh, { signedIn: false });
  // Two presses at once (a double click): the first stands down.
  const [first, second] = await Promise.all([call("store:github-sign-in"), call("store:github-sign-in")]); // prettier-ignore
  assert.equal(first.code, "cancelled");
  assert.equal(second.ok, true);
  assert.equal(second.userCode, "ABCD-1234");
  const done = await call("store:github-sign-in-wait");
  assert.deepEqual(done, { ok: true, login: "ann" });
  assert.equal(JSON.parse(creds.token).token, TOKEN, "kept in the credential store"); // prettier-ignore
  assert.equal(settings.githubLogin, "ann");
  assert.equal((await call("store:status")).github.signedIn, true);
  await call("store:github-sign-out");
  assert.equal(creds.token, null);
  // Cancelled while waiting: answered as cancelled, nothing kept.
  gh.polls = -1e9; // GitHub keeps saying "pending"
  await call("store:github-sign-in");
  const waiting = call("store:github-sign-in-wait");
  await call("store:github-sign-in-cancel");
  assert.equal((await waiting).code, "cancelled");
  assert.equal(creds.token, null);
});

test("a GitHub store that is (or turns) PUBLIC is never joined or saved to", async () => {
  const gh = fakeGitHub();
  const { call } = mainWith(gh);
  const made = await call("store:add-github", { mode: "create", name: "Lab" });
  assert.equal(made.ok, true, JSON.stringify(made));
  const {
    parseStoreLink,
  } = require("../../web/scripts/stores/store-format.js");
  const ref = parseStoreLink((await call("store:link", made.store.id)).web);
  const doc = { version: 15, boards: [], components: [], wires: [] };
  const fields = { title: "Gates", author: "Ann", description: "", tags: [] };
  const first = await call("store:save", { id: made.store.id, fields, desktop: { doc } }); // prettier-ignore
  assert.equal(first.ok, true, JSON.stringify(first));
  // The owner makes the repository public.
  gh.public.add(made.store.repo);
  assert.equal((await call("store:save", { id: made.store.id, fields, desktop: { doc } })).code, "storePublic"); // prettier-ignore
  const friend = mainWith(gh);
  assert.equal((await friend.call("store:add-github", { mode: "join", ref })).code, "storePublic"); // prettier-ignore
  assert.equal((await friend.call("store:add-github", { mode: "join", ref: { junk: true } })).code, "badLink"); // prettier-ignore
});

test("Add Store ▸ GitHub ▸ one of my repositories, through main: private only, a folder of its own, and the link says which folder", async () => {
  const { registerStoresIpc } = require("../ipc/stores");
  const {
    parseStoreLink,
  } = require("../../web/scripts/stores/store-format.js");
  const gh = fakeGitHub();
  const { repo } = await createRepo({ token: TOKEN, name: "website", fetch: gh.fetch }); // prettier-ignore
  gh.repos.get(repo).set("index.html", Buffer.from("<html>"));
  const { repo: open } = await createRepo({ token: TOKEN, name: "open", fetch: gh.fetch }); // prettier-ignore
  gh.public.add(open);
  const handlers = new Map();
  const settings = {};
  const mainWc = {};
  registerStoresIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    dialog: {},
    shell: {},
    enabled: () => true,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: mainWc }),
    getBrowseWindow: () => null,
    getSettingsStore: () => ({ get: () => ({ ...settings }), set: (p) => Object.assign(settings, p) }), // prettier-ignore
    getBookmarks: () => ({ withAccess: (_p, fn) => fn() }),
    getCredentialStore: () => ({ available: () => true, keyFor: () => TOKEN }),
    getProjectStore: () => null,
    prepareShare: () => ({ ok: false }),
    plainImages: (i) => i,
    captureRect: async () => null,
    sendToMain: () => {},
    showMainWindow: () => {},
    m: (_k, fallback) => fallback,
    appVersion: () => "1.6.0",
    docVersion: 15,
    fetch: gh.fetch,
  });
  const call = (ch, ...args) => handlers.get(ch)({ sender: mainWc }, ...args);
  assert.deepEqual((await call("store:github-repos")).repos, [{ repo }]);
  assert.equal((await call("store:add-github", { mode: "existing", repo: open, dir: "chiphippo", name: "Lab" })).code, "pickPublic"); // prettier-ignore
  assert.equal((await call("store:add-github", { mode: "existing", repo, dir: "../up", name: "Lab" })).code, "badFolder"); // prettier-ignore
  assert.equal((await call("store:add-github", { mode: "existing", repo, dir: "", name: "Lab" })).code, "badFolder", "a folder of its own, always"); // prettier-ignore
  const made = await call("store:add-github", { mode: "existing", repo, dir: "chiphippo", name: "Lab" }); // prettier-ignore
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.store.dir, "chiphippo");
  assert.ok(gh.repos.get(repo).has("chiphippo/chiphippo-store.json"));
  assert.ok(gh.repos.get(repo).has("index.html"), "what was there stays");
  // The same folder again is the same store, added — not made twice.
  const again = await call("store:add-github", { mode: "existing", repo, dir: "chiphippo", name: "Other" }); // prettier-ignore
  assert.equal(again.store.id, made.store.id);
  assert.equal(settings.stores.length, 1);
  // A friend's link carries the folder.
  const ref = parseStoreLink((await call("store:link", made.store.id)).web);
  assert.deepEqual(ref.where, { repo, dir: "chiphippo" });
  const view = await call("store:view", made.store.id);
  assert.equal(view.ok, true, JSON.stringify(view));
  assert.equal(view.entries.length, 0);
});

test("a picture in a GitHub store comes back as a picture (raw bytes, never parsed)", async () => {
  const gh = fakeGitHub();
  const { repo } = await createRepo({ token: TOKEN, name: "Lab", fetch: gh.fetch }); // prettier-ignore
  const backend = new GitHubBackend(repo, { token: () => TOKEN, fetch: gh.fetch }); // prettier-ignore
  await backend.add("chiphippo-store.json", JSON.stringify(makeManifest({ id: ID, name: "Lab" }))); // prettier-ignore
  const store = { id: ID, name: "Lab", kind: "github", where: { repo } };
  const service = new StoreService({
    backendFor: () => backend,
    sha256Hex: (d) => crypto.createHash("sha256").update(d).digest("hex"),
    randomHex: (n) => crypto.randomBytes(n).toString("hex"),
  });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]); // prettier-ignore
  const saved = await service.save(store, { design: JSON.stringify({ kind: "desktop", doc: {} }), fields: { title: "Gates", author: "Ann", description: "", tags: [] }, thumb: png, app: {} }); // prettier-ignore
  const url = await service.thumb(store, saved.entry, saved.rev);
  assert.equal(url, `data:image/png;base64,${png.toString("base64")}`);
});

test("GitHub's limits, a renamed repository and a listing cut short are each said as what they are", async () => {
  const answer =
    (status, headers = {}, body = {}) =>
    async () =>
      new Response(JSON.stringify(body), { status, headers });
  const ask = (fetch) => request("https://api.github.com/user", { token: TOKEN, fetch }); // prettier-ignore
  await assert.rejects(ask(answer(403, { "retry-after": "60" })), { code: "rateLimited" }); // prettier-ignore
  await assert.rejects(ask(answer(403, { "x-ratelimit-remaining": "0" })), { code: "rateLimited" }); // prettier-ignore
  await assert.rejects(ask(answer(403)), { code: "noAccess" });
  await assert.rejects(ask(answer(301, { location: "https://api.github.com/repositories/1" })), { code: "moved" }); // prettier-ignore
  const big = new GitHubBackend("ann/huge", { token: () => TOKEN, fetch: answer(200, {}, { truncated: true, tree: [{ path: "chiphippo-store.json", type: "blob" }] }) }); // prettier-ignore
  await assert.rejects(big.list(), { code: "tooLarge" });
});

test("a later GraphQL batch failing fails the view — never half the metas — and keeps what arrived", async () => {
  const gh = fakeGitHub();
  const { repo } = await createRepo({ token: TOKEN, name: "Big", fetch: gh.fetch }); // prettier-ignore
  const backend = new GitHubBackend(repo, { token: () => TOKEN, fetch: gh.fetch }); // prettier-ignore
  await backend.add("chiphippo-store.json", JSON.stringify(makeManifest({ id: ID, name: "Big" }))); // prettier-ignore
  const store = { id: ID, name: "Big", kind: "github", where: { repo } };
  const writer = new StoreService({
    backendFor: () => backend,
    sha256Hex: (d) => crypto.createHash("sha256").update(d).digest("hex"),
    randomHex: (n) => crypto.randomBytes(n).toString("hex"),
  });
  // 30 designs: 1 manifest + 30 entries + 30 metas = 61 files, two batches.
  for (let n = 0; n < 30; n += 1) {
    await writer.save(store, { design: JSON.stringify({ kind: "desktop", n, doc: {} }), fields: { title: `Design ${n}`, author: "Ann", description: "", tags: [] }, app: {} }); // prettier-ignore
  }
  let graphql = 0;
  const flaky = async (url, init) => {
    if (url.endsWith("/graphql") && ++graphql === 2) throw new Error("network down"); // prettier-ignore
    return gh.fetch(url, init);
  };
  const reader = new StoreService({ backendFor: () => new GitHubBackend(repo, { token: () => TOKEN, fetch: flaky }), sha256Hex: () => "0".repeat(64), randomHex: () => "000000" }); // prettier-ignore
  await assert.rejects(reader.view(store), { code: "unavailable" });
  // The next look asks only for what is still missing, and opens whole.
  const view = await reader.view(store);
  assert.equal(view.entries.length, 30);
  assert.equal(graphql, 3, "the first batch was kept, not asked again");
});

test("Cancel while GitHub is still answering the start: that sign-in stands down", async () => {
  const gh = fakeGitHub();
  let release;
  const slow = async (url, init) => {
    if (url.endsWith("/login/device/code")) await new Promise((r) => (release = r)); // prettier-ignore
    return gh.fetch(url, init);
  };
  const { call, creds } = mainWith({ ...gh, fetch: slow }, { signedIn: false });
  const starting = call("store:github-sign-in");
  await new Promise((r) => setTimeout(r, 0));
  await call("store:github-sign-in-cancel");
  release();
  assert.equal((await starting).code, "cancelled");
  assert.equal(creds.token, null);
});

test("a store folder deep inside a busy repository is found by its path", async () => {
  const gh = fakeGitHub();
  const { repo } = await createRepo({ token: TOKEN, name: "site", fetch: gh.fetch }); // prettier-ignore
  for (let n = 0; n < 1200; n += 1) gh.repos.get(repo).set(`docs/page-${n}.md`, Buffer.from("x")); // prettier-ignore
  const backend = new GitHubBackend(repo, { token: () => TOKEN, fetch: gh.fetch, dir: "docs/chiphippo" }); // prettier-ignore
  await assert.rejects(backend.list(), { code: "missing" });
  await backend.add("chiphippo-store.json", JSON.stringify(makeManifest({ id: ID, name: "Lab" }))); // prettier-ignore
  assert.deepEqual(await backend.list(), ["chiphippo-store.json"]);
});

test("a sign-in cancelled while its last poll is out keeps no token", async () => {
  const gh = fakeGitHub();
  let release;
  let polled = false;
  const slow = async (url, init) => {
    if (url.endsWith("/login/oauth/access_token")) {
      polled = true;
      await new Promise((r) => (release = r));
      return new Response(JSON.stringify({ access_token: TOKEN }), { status: 200 }); // prettier-ignore
    }
    return gh.fetch(url, init);
  };
  const { call, creds } = mainWith({ ...gh, fetch: slow }, { signedIn: false });
  assert.equal((await call("store:github-sign-in")).ok, true);
  const waiting = call("store:github-sign-in-wait");
  while (!polled) await new Promise((r) => setTimeout(r, 0));
  await call("store:github-sign-in-cancel");
  release();
  assert.equal((await waiting).code, "cancelled");
  assert.equal(creds.token, null);
});

test("GraphQL errors beside the data fail the batch — no meta quietly missing", async () => {
  const backend = new GitHubBackend("ann/lab", {
    token: () => TOKEN,
    fetch: async () => new Response(JSON.stringify({ data: { repository: { f0: null } }, errors: [{ message: "timeout" }] }), { status: 200 }), // prettier-ignore
  });
  await assert.rejects(backend.readMany(["chiphippo-store.json"]), { code: "unavailable" }); // prettier-ignore
});

test("an expiring GitHub sign-in (8-hour tokens) is refreshed as it runs out — once, however many ask", async () => {
  const gh = fakeGitHub();
  gh.expiring = true;
  // The fake's token check: drop the long-lived test token, so only the
  // issued pair works.
  let now = Date.now();
  const { call, creds } = mainWith(gh, { signedIn: false, clock: () => now });
  assert.equal((await call("store:github-sign-in")).ok, true);
  assert.equal((await call("store:github-sign-in-wait")).ok, true);
  gh.valid.delete(TOKEN);
  const kept = JSON.parse(creds.token);
  assert.equal(kept.token, "tok-0");
  assert.equal(kept.refreshToken, "ref-0");
  assert.ok(kept.expiresAt > now);
  assert.equal(
    (await call("store:github-repos")).ok,
    true,
    "a fresh token is used as it is",
  );
  assert.equal(gh.refreshes, 0);
  // Nine hours later: two requests at once trade the refresh token ONCE.
  now += 9 * 3600 * 1000;
  const [a, b] = await Promise.all([call("store:github-repos"), call("store:github-repos")]); // prettier-ignore
  assert.equal(a.ok && b.ok, true, JSON.stringify([a, b]));
  assert.equal(gh.refreshes, 1);
  assert.equal(JSON.parse(creds.token).token, "tok-1");
  assert.equal(JSON.parse(creds.token).refreshToken, "ref-1");
  // A refresh token GitHub no longer takes: signed out, and said so.
  gh.refreshTokens.clear();
  now += 9 * 3600 * 1000;
  assert.equal((await call("store:github-repos")).code, "signedOut");
  assert.equal((await call("store:status")).github.signedIn, false);
});

test("a sign-in kept before expiring tokens (the bare token) still works", async () => {
  const gh = fakeGitHub();
  const { call } = mainWith(gh); // creds.token is the bare TOKEN
  assert.equal((await call("store:status")).github.signedIn, true);
  assert.equal((await call("store:github-repos")).ok, true);
});

test("a refresh GitHub refuses, or a token revoked on GitHub, signs out — never 'signed in' over failing requests", async () => {
  const gh = fakeGitHub();
  gh.expiring = true;
  // GitHub wants something more for the refresh (any OAuth error) once
  // `refuse` is set.
  const real = gh.fetch;
  let refuse = false;
  gh.fetch = async (url, init) =>
    refuse && url.endsWith("/login/oauth/access_token")
      ? new Response(JSON.stringify({ error: "incorrect_client_credentials" }), { status: 200 })
      : real(url, init); // prettier-ignore
  let now = Date.now();
  const { call, creds } = mainWith(gh, { signedIn: false, clock: () => now });
  await call("store:github-sign-in");
  await call("store:github-sign-in-wait");
  gh.valid.delete(TOKEN);
  refuse = true;
  now += 9 * 3600 * 1000;
  assert.equal((await call("store:github-repos")).code, "signedOut");
  assert.equal(creds.token, null, "the sign-in is gone");
  assert.equal((await call("store:status")).github.signedIn, false);
  // A long-lived token revoked on GitHub: the first 401 forgets it.
  const plain = mainWith(fakeGitHub());
  plain.creds.token = "gho_revoked";
  assert.equal((await plain.call("store:status")).github.signedIn, true);
  assert.equal((await plain.call("store:github-repos")).code, "signedOut");
  assert.equal((await plain.call("store:status")).github.signedIn, false);
});
