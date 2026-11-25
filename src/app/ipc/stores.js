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

/**
 * ipc/stores.js — the PRIVATE STORES' main half (the private stores work,
 * .claude/rules/stores.md): the stores this machine has added, each one's
 * view for the Browse window, opening a revision, saving one, and setting a
 * store up — a folder the user picks, or a private GitHub repository made or
 * joined after a device-flow sign-in.
 *
 * WHAT THE RENDERER MAY NAME: a store by its id (the registry, main-owned,
 * says where it is), an entry and a revision by the ids store-format.js
 * admits, a guide page by its key. Never a path or a URL. A folder is chosen
 * in main's own dialog, inside the handler that adds it.
 *
 * WHICH WINDOWS: the Browse window reads (list, view, thumb, open — relayed
 * to the app window); everything that writes, signs in or sets up answers
 * the app window only.
 *
 * OFF in the web build
 * (its filesystem is the tab's own, so a folder store there would be a store
 * no friend could ever reach).
 *
 *   store:status            → {enabled, github: {configured, signedIn, login}}
 *   store:list              → [public store]
 *   store:add-folder (opts) → {ok, store} | {ok:false, code} | null (cancelled)
 *   store:add-github (opts) → {ok, store} | {ok:false, code}
 *   store:remove (id)       → boolean
 *   store:link (id)         → {web, app} | null
 *   store:view (id)         → {ok, store, entries} | {ok:false, code}
 *   store:thumb (id, entry, rev) → {ok, url}
 *   store:open (id, entry, rev)  → relayed to the app window
 *   store:open-entry (id, entry, rev) → the design, unreseated
 *   store:capture-thumb (rect) → {ok, token}
 *   store:save (payload)    → {ok, entry, rev} | {ok:false, code, head?}
 *   store:reveal (id), store:guide (key) → boolean
 *   store:github-sign-in, -wait, -cancel, -sign-out; store:github-repos;
 *   store:invite; store:people
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { ENTRY_ID_RE } = require("../../web/scripts/gallery/entry-format.js");
const {
  GITHUB_REPO_RE,
  REV_RE,
  STORE_ID_RE,
  githubDir,
  makeManifest,
  normalizeStoreRef,
  storeLink,
  storeName,
} = require("../../web/scripts/stores/store-format.js");
const registry = require("../stores/registry");
const { FolderBackend, findStoreFolder, makeFolderStore } = require("../stores/folder"); // prettier-ignore
const github = require("../stores/github");
const { GITHUB_API, githubClientId, guidePage, repoPage } = require("../stores/sources"); // prettier-ignore
const { StoreService } = require("../stores/service");

/** The codes the renderer has words for (`stores.error.<code>`). */
const CODES = Object.freeze([
  "missing",
  "noAccess",
  "signedOut",
  "rateLimited",
  "wrongStore",
  "ambiguous",
  "notStore",
  "behind",
  "newer",
  "full",
  "denied",
  "tooBig",
  "romTooBig",
  "invalid",
  "badFolder",
  "badLink",
  "badLogin",
  "pickPublic",
  "storePublic",
  "noPush",
  "moved",
  "tooLarge",
  "alreadyAdded",
  "noUser",
  "nameTaken",
  "notPrivate",
  "notConfigured",
  "noKeychain",
  "notInvited",
  "signInDenied",
  "cancelled",
  "unavailable",
]);
const codeOf = (err) => (CODES.includes(err?.code) ? err.code : "unavailable");
const failed = (err) => ({ ok: false, code: codeOf(err) });

/** How long a captured picture waits for its save (ms). */
const THUMB_TTL_MS = 10 * 60 * 1000;

/**
 * @param {object} deps
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {Electron.Dialog} deps.dialog
 * @param {Electron.Shell} deps.shell
 * @param {() => boolean} deps.enabled - not the web build.
 * @param {() => Electron.BrowserWindow|null} deps.getMainWindow
 * @param {() => Electron.BrowserWindow|null} deps.getBrowseWindow
 * @param {() => {get: Function, set: Function}} deps.getSettingsStore
 * @param {() => object} deps.getBookmarks
 * @param {() => object} deps.getCredentialStore
 * @param {() => object} deps.getProjectStore
 * @param {(payload: object, deps: object) => object} deps.prepareShare -
 *   gallery/gate.js's: the snapshot built and capped.
 * @param {(images: object) => object|null} deps.plainImages
 * @param {(rect: object) => Promise<Buffer|null>} deps.captureRect - a PNG
 *   of the app window's box.
 * @param {(channel: string, payload?: unknown) => void} deps.sendToMain
 * @param {() => void} deps.showMainWindow
 * @param {() => void} deps.onStoresChanged - the bookmark pruning.
 * @param {(key: string, fallback: string, params?: object) => string} deps.m
 * @param {() => string} deps.appVersion
 * @param {number} deps.docVersion
 * @param {string|null} [deps.devClientId]
 * @param {typeof fetch} [deps.fetch]
 */
function registerStoresIpc(deps) {
  const { ipcMain, dialog, shell, m } = deps;
  const fetch = deps.fetch ?? globalThis.fetch;
  /** The wait between sign-in polls (a test passes one that does not). */
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const credentials = () => deps.getCredentialStore();
  /** As `failed`, and a 401 (a token revoked on GitHub) forgets the
      sign-in, so the guide offers Sign In again instead of "signed in" over
      requests that all fail. */
  const failedHere = (err) => {
    const out = failed(err);
    if (out.code === "signedOut") credentials().clear("github");
    return out;
  };
  const clock = deps.clock ?? Date.now;

  // ── The GitHub sign-in as kept ──
  // A JSON record `{token, refreshToken?, expiresAt?, refreshExpiresAt?}` in
  // the credential store (one encrypted string), or — from before expiring
  // tokens — the bare token. An OAuth App with "Expire user access tokens"
  // hands out 8-hour tokens with a 6-month refresh token, so the sign-in is
  // refreshed as it runs out, and lasts as long as it is used.
  const readSignIn = () => {
    const raw = credentials().keyFor("github", GITHUB_API);
    if (!raw) return null;
    if (!raw.startsWith("{")) return { token: raw };
    try {
      const rec = JSON.parse(raw);
      return typeof rec?.token === "string" && rec.token ? rec : null;
    } catch {
      return null;
    }
  };
  /** Keep a token answer (`{token, refreshToken?, expiresIn?,
      refreshExpiresIn?}` — lifetimes in seconds) as times on this clock; a
      refresh that names no new refresh token keeps the one it had. */
  const keepSignIn = (answer, before = null) => {
    const at = clock();
    const rec = {
      token: answer.token,
      refreshToken: answer.refreshToken ?? before?.refreshToken ?? null,
      expiresAt: answer.expiresIn ? at + answer.expiresIn * 1000 : null,
      refreshExpiresAt: answer.refreshExpiresIn
        ? at + answer.refreshExpiresIn * 1000
        : (before?.refreshExpiresAt ?? null),
    };
    return credentials().set("github", JSON.stringify(rec), { origin: GITHUB_API }); // prettier-ignore
  };
  /** The access token to send, or null (signed out, or the refresh token
      itself has run out — sign in again). */
  const token = () => {
    const rec = readSignIn();
    if (!rec) return null;
    if (rec.refreshExpiresAt && rec.refreshExpiresAt <= clock()) return null;
    // An access token past its time is no sign-in (its refresh, if any, is
    // tried first by `ensureFresh`; one that could not be made leaves this).
    if (rec.expiresAt && rec.expiresAt <= clock()) return null;
    return rec.token;
  };
  /** Refresh a token due within this long, so none expires mid-request. */
  const REFRESH_MARGIN_MS = 5 * 60 * 1000;
  let refreshing = null;
  /**
   * When the kept token is due, trade its refresh token for a new pair —
   * once, however many requests ask at the same moment (GitHub rotates the
   * refresh token, so a second trade with the old one would sign the user
   * out). Answers null, synchronously, when nothing is due: the handlers
   * keep their order then.
   */
  const ensureFresh = () => {
    if (refreshing) return refreshing;
    const rec = readSignIn();
    if (!rec?.refreshToken || !rec.expiresAt || !clientId()) return null;
    if (rec.expiresAt - REFRESH_MARGIN_MS > clock()) return null;
    refreshing = (async () => {
      try {
        const next = await github.refreshAccessToken({ clientId: clientId(), refreshToken: rec.refreshToken, fetch }); // prettier-ignore
        keepSignIn(next, rec);
      } catch (err) {
        // Refused: signed out, said as such by the next request. A network
        // blip leaves the old token, and the next request tries again.
        if (err?.code === "signedOut") credentials().clear("github");
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };
  // `deps.githubClientId` is a test's way to state the app (or none, "");
  // otherwise the registered one, or a dev launch's override.
  const clientId = () =>
    typeof deps.githubClientId === "string"
      ? deps.githubClientId
      : githubClientId({ devClientId: deps.devClientId });

  const list = () => registry.sanitizeStores(deps.getSettingsStore().get().stores); // prettier-ignore
  const setList = (next) => {
    deps.getSettingsStore().set({ stores: next });
    deps.onStoresChanged?.();
  };
  const find = (id) => (STORE_ID_RE.test(id ?? "") ? registry.findStore(list(), id) : null); // prettier-ignore

  const backendFor = (store) =>
    store.kind === "github"
      ? new github.GitHubBackend(store.where.repo, { token, fetch, dir: store.where.dir ?? "" }) // prettier-ignore
      : new FolderBackend(store.where.path, {
          access: (fn) => deps.getBookmarks().withAccess(store.where.grant, fn, { keep: true }), // prettier-ignore
        });
  const service = new StoreService({
    backendFor,
    sha256Hex: (d) => crypto.createHash("sha256").update(d).digest("hex"),
    randomHex: (n) => crypto.randomBytes(n).toString("hex"),
  });

  /** What the renderer sees of a store: never a token, a path only for the
      user's own folder (Settings shows where it is). */
  const publicStore = (s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    provider: s.kind === "github" ? "github" : s.where.provider,
    ...(s.kind === "github"
      ? { repo: s.where.repo, ...(s.where.dir ? { dir: s.where.dir } : {}) }
      : { path: s.where.path }),
    added: s.added,
  });

  const win = (w) => (w && !w.isDestroyed() ? w : null);
  const fromApp = (event) => event?.sender === win(deps.getMainWindow())?.webContents; // prettier-ignore
  const fromBrowse = (event) => event?.sender === win(deps.getBrowseWindow?.())?.webContents; // prettier-ignore
  const readable = (event) => fromApp(event) || fromBrowse(event);
  const OFF = { ok: false, code: "unavailable" };

  /** A handler for the app window only (and never the web build). */
  /** Run a handler, the GitHub sign-in refreshed first when it is due. */
  const fresh = (fn, args) => {
    const due = ensureFresh();
    return due ? due.then(() => fn(...args)) : fn(...args);
  };
  const appOnly = (fn) => (event, ...args) => (deps.enabled() && fromApp(event) ? fresh(fn, args) : OFF); // prettier-ignore
  /** A handler for the app and Browse windows (never the web build). */
  const reader = (fn) => (event, ...args) => (deps.enabled() && readable(event) ? fresh(fn, args) : OFF); // prettier-ignore

  const now = () => new Date().toISOString();
  /** Where a store record points, for comparing two of them. */
  const placeOf = (s) =>
    s.kind === "folder" ? `folder:${path.resolve(s.where.path)}` : `github:${s.where.repo.toLowerCase()}/${s.where.dir ?? ""}`; // prettier-ignore
  const remember = (store) => {
    // A store this computer already has, somewhere ELSE, is refused: a link
    // (or a folder) whose manifest merely copies a store's id must never
    // quietly re-point that store — and the next "new version" with it.
    const had = registry.findStore(list(), store.id);
    if (had && placeOf(had) !== placeOf(store)) {
      throw Object.assign(new Error("alreadyAdded"), { code: "alreadyAdded", name: had.name }); // prettier-ignore
    }
    const { list: next, added } = registry.addStore(list(), { ...store, added: now() }); // prettier-ignore
    if (!added) throw Object.assign(new Error("full"), { code: "full" });
    service.forget(store.id);
    setList(next);
    return publicStore(registry.findStore(next, store.id));
  };

  const showOpen = async (opts) => {
    const parent = win(deps.getMainWindow());
    const o = deps.getBookmarks().dialogOpts(opts);
    return parent ? dialog.showOpenDialog(parent, o) : dialog.showOpenDialog(o);
  };

  // ── Reading ──
  ipcMain.handle("store:status", (event) => {
    if (!deps.enabled() || !readable(event)) return { enabled: false };
    const store = credentials();
    return {
      enabled: true,
      github: {
        configured: Boolean(clientId()),
        signedIn: Boolean(token()),
        login: typeof deps.getSettingsStore().get().githubLogin === "string" ? deps.getSettingsStore().get().githubLogin : "", // prettier-ignore
        encryptionAvailable: store.available(),
      },
    };
  });
  ipcMain.handle("store:list", (event) =>
    deps.enabled() && readable(event) ? list().map(publicStore) : [],
  );
  ipcMain.handle("store:link", (event, id) => {
    if (!deps.enabled() || !readable(event)) return null;
    const store = find(id);
    const ref = store && registry.storeRefOf(store);
    return ref ? { web: storeLink(ref), app: storeLink(ref, { web: false }) } : null; // prettier-ignore
  });
  ipcMain.handle(
    "store:view",
    reader(async (id) => {
      const store = find(id);
      if (!store) return { ok: false, code: "missing" };
      try {
        const { manifest, entries } = await service.view(store);
        return {
          ok: true,
          store: { ...publicStore(store), newer: manifest.newer === true },
          entries,
        };
      } catch (err) {
        return failedHere(err);
      }
    }),
  );
  const revArgs = (id, entry, rev) =>
    find(id) && ENTRY_ID_RE.test(entry ?? "") && REV_RE.test(rev ?? "") ? find(id) : null; // prettier-ignore
  ipcMain.handle(
    "store:thumb",
    reader(async (id, entry, rev) => {
      const store = revArgs(id, entry, rev);
      if (!store) return { ok: false, code: "invalid" };
      try {
        const url = await service.thumb(store, entry, rev);
        return url ? { ok: true, url } : { ok: false, code: "missing" };
      } catch (err) {
        return failedHere(err);
      }
    }),
  );
  // The Browse window's Open: handed to the app window, which owns the
  // project it lands in (gallery:open's relay).
  ipcMain.handle(
    "store:open",
    reader((id, entry, rev) => {
      if (!revArgs(id, entry, rev)) return false;
      deps.showMainWindow();
      deps.sendToMain("store:host-inbound", { id, entry, rev });
      return true;
    }),
  );
  // The design itself, NOT yet reseated (gallery:open-entry's shape), with
  // where it came from — what the desktop it lands as remembers.
  ipcMain.handle(
    "store:open-entry",
    appOnly(async (id, entry, rev) => {
      const store = revArgs(id, entry, rev);
      if (!store) return { ok: false, code: "invalid" };
      try {
        const { raw, meta } = await service.design(store, entry, rev);
        const snapshot = deps.getProjectStore().desktopSnapshotOf(raw, entry);
        if (!snapshot) return { ok: false, code: "invalid" };
        return {
          ok: true,
          name: snapshot.name,
          description: snapshot.description,
          doc: snapshot.doc,
          images: deps.plainImages(snapshot.images) ?? {},
          customChips: snapshot.customChips ?? [],
          pin: typeof meta?.appVersion === "string" ? meta.appVersion : null,
          engine: meta?.derived?.engine === "spice" ? "spice" : "logic",
          from: { store: id, entry, rev },
        };
      } catch (err) {
        return failedHere(err);
      }
    }),
  );

  // ── Saving ──
  /** token → {png, at}: pictures taken before the Save card opened (a card
      on screen would be in the picture). One at a time is all a card needs. */
  const pictures = new Map();
  ipcMain.handle(
    "store:capture-thumb",
    appOnly(async (rect) => {
      for (const [k, v] of pictures) if (Date.now() - v.at > THUMB_TTL_MS) pictures.delete(k); // prettier-ignore
      const png = await deps.captureRect(rect).catch(() => null);
      if (!png) return { ok: false, code: "unavailable" };
      const key = crypto.randomBytes(12).toString("hex");
      pictures.clear();
      pictures.set(key, { png, at: Date.now() });
      return { ok: true, token: key };
    }),
  );
  ipcMain.handle(
    "store:save",
    appOnly(async (payload) => {
      const { id, entry = null, base = null, fork = false, fields, note = "", desktop, derived = null, thumbToken = null } = payload ?? {}; // prettier-ignore
      const store = find(id);
      if (!store) return { ok: false, code: "missing" };
      if (entry != null && !ENTRY_ID_RE.test(entry)) return { ok: false, code: "invalid" }; // prettier-ignore
      if (base != null && !REV_RE.test(base)) return { ok: false, code: "invalid" }; // prettier-ignore
      const prepared = deps.prepareShare(
        { doc: desktop?.doc, customChips: desktop?.customChips, entry: fields },
        { consent: "yes", buildSnapshot: (s) => deps.getProjectStore().buildDesktopSnapshot(s) }, // prettier-ignore
      );
      if (!prepared.ok) return prepared;
      // The picture is spent only by a save that lands: one refused as
      // "behind" is pressed again (Save Mine Alongside) with the same token.
      const picture = typeof thumbToken === "string" ? pictures.get(thumbToken) : null; // prettier-ignore
      try {
        // A GitHub store is checked to be private still before anything is
        // written: a repository made public since it was joined would publish
        // the design.
        if (store.kind === "github") {
          const t = token();
          if (!t) return { ok: false, code: "signedOut" };
          const access = await github.repoAccess({ token: t, repo: store.where.repo, fetch }); // prettier-ignore
          if (!access.private) return { ok: false, code: "storePublic" };
        }
        const saved = await service.save(store, {
          design: prepared.design,
          fields: prepared.entry,
          entry,
          base,
          fork: fork === true,
          note: typeof note === "string" ? note : "",
          derived,
          thumb: picture?.png ?? null,
          app: { appVersion: deps.appVersion(), docVersion: deps.docVersion },
        });
        if (picture) pictures.delete(thumbToken);
        return { ok: true, ...saved };
      } catch (err) {
        return err?.code === "behind" ? { ok: false, code: "behind", head: err.head } : failedHere(err); // prettier-ignore
      }
    }),
  );

  // ── Setting up ──
  ipcMain.handle(
    "store:add-folder",
    appOnly(async (opts = {}) => {
      // "create" a new store; "join" the one a link names; "open" a store
      // folder already on this machine, with no link.
      if (!["create", "join", "open"].includes(opts.mode)) return { ok: false, code: "invalid" }; // prettier-ignore
      const ref = opts.mode === "join" ? normalizeStoreRef(opts.ref) : null;
      if (opts.mode === "join" && (!ref || ref.kind !== "folder")) return { ok: false, code: "badLink" }; // prettier-ignore
      const name = storeName(opts.name);
      if (opts.mode === "create" && !name)
        return { ok: false, code: "invalid" };
      const result = await showOpen({
        title: opts.mode === "create"
          ? m("dialog.storeCreate.title", "Where should the store's folder go?")
          : m("dialog.storeJoin.title", "Choose the shared folder"),
        buttonLabel: opts.mode === "create"
          ? m("dialog.storeCreate.button", "Make the Store Here")
          : m("dialog.storeJoin.button", "Use This Folder"),
        properties: ["openDirectory", "createDirectory"],
      }); // prettier-ignore
      if (result.canceled || !result.filePaths?.[0]) return null;
      deps.getBookmarks().captureOpen(result);
      const grant = path.resolve(result.filePaths[0]);
      const access = (fn) => deps.getBookmarks().withAccess(grant, fn, { keep: true }); // prettier-ignore
      const provider = ref ? ref.where.provider : (opts.provider ?? "other"); // prettier-ignore
      try {
        if (opts.mode === "create") {
          // Full: said BEFORE a folder is made, never one left unlisted.
          if (list().length >= registry.MAX_STORES) return { ok: false, code: "full" }; // prettier-ignore
          const id = `s-${crypto.randomBytes(8).toString("hex")}`;
          const dir = makeFolderStore(grant, { id, name, created: now() }, { access }); // prettier-ignore
          return { ok: true, store: remember({ id, name, kind: "folder", where: { path: dir, grant, provider } }) }; // prettier-ignore
        }
        // Joining: the folder the friend shared, or the one just above it.
        const found = await findStoreFolder(grant, { expectId: ref?.id ?? null, access }); // prettier-ignore
        return {
          ok: true,
          store: remember({ id: found.manifest.id, name: ref?.name || found.manifest.name, kind: "folder", where: { path: found.path, grant, provider } }), // prettier-ignore
        };
      } catch (err) {
        return failedHere(err);
      }
    }),
  );
  ipcMain.handle(
    "store:add-github",
    appOnly(async (opts = {}) => {
      const t = token();
      if (!t) return { ok: false, code: "signedOut" };
      try {
        if (opts.mode === "create") {
          const name = storeName(opts.name);
          if (!name) return { ok: false, code: "invalid" };
          if (list().length >= registry.MAX_STORES) return { ok: false, code: "full" }; // prettier-ignore
          const { repo } = await github.createRepo({ token: t, name, description: m("stores.repoDescription", "Chip Hippo designs, shared"), fetch }); // prettier-ignore
          const id = `s-${crypto.randomBytes(8).toString("hex")}`;
          const backend = new github.GitHubBackend(repo, { token, fetch });
          await backend.add("chiphippo-store.json", `${JSON.stringify(makeManifest({ id, name, created: now() }), null, 2)}\n`, { message: "A Chip Hippo store" }); // prettier-ignore
          return { ok: true, store: remember({ id, name, kind: "github", where: { repo } }) }; // prettier-ignore
        }
        if (opts.mode === "existing") {
          // A repository the user already has: the store goes in a folder of
          // its own there (`dir`), out of the way of what else it holds.
          // Only a PRIVATE one the account can write to; a folder already
          // holding a store is that store, added rather than made again.
          const name = storeName(opts.name);
          const dir = githubDir(opts.dir);
          if (!GITHUB_REPO_RE.test(opts.repo ?? "")) return { ok: false, code: "invalid" }; // prettier-ignore
          // A folder of its own, always: at the repository's root the store
          // would sit among everything else, and a large repository's
          // listing is cut short (`tooLarge`).
          if (!dir) return { ok: false, code: "badFolder" };
          let access;
          try {
            access = await github.repoAccess({ token: t, repo: opts.repo, fetch }); // prettier-ignore
          } catch (err) {
            return failedHere(
              err.code === "noAccess" ? { code: "noAccess" } : err,
            );
          }
          if (!access.private) return { ok: false, code: "pickPublic" };
          if (!access.push) return { ok: false, code: "noPush" };
          const backend = new github.GitHubBackend(opts.repo, { token, fetch, dir }); // prettier-ignore
          const there = await backend.manifest();
          if (there) {
            return { ok: true, store: remember({ id: there.id, name: there.name, kind: "github", where: { repo: opts.repo, dir } }) }; // prettier-ignore
          }
          if (!name) return { ok: false, code: "invalid" };
          const id = `s-${crypto.randomBytes(8).toString("hex")}`;
          await backend.add("chiphippo-store.json", `${JSON.stringify(makeManifest({ id, name, created: now() }), null, 2)}\n`, { message: "A Chip Hippo store" }); // prettier-ignore
          return { ok: true, store: remember({ id, name, kind: "github", where: { repo: opts.repo, dir } }) }; // prettier-ignore
        }
        const ref = normalizeStoreRef(opts.ref);
        if (!ref || ref.kind !== "github")
          return { ok: false, code: "badLink" };
        // The friend's side: take the invitation that is waiting, if one is,
        // then prove the store is there and is the one the link named.
        await github.acceptInvitation({ token: t, repo: ref.where.repo, fetch }).catch(() => "none"); // prettier-ignore
        // A repository not shared with this account answers 404 — asked
        // first, since a missing FILE answers the same.
        let access;
        try {
          access = await github.repoAccess({ token: t, repo: ref.where.repo, fetch }); // prettier-ignore
        } catch (err) {
          if (err.code === "noAccess") return { ok: false, code: "notInvited" };
          throw err;
        }
        // A link to a PUBLIC repository — or one made public since — is no
        // private store: anything saved there would be published.
        if (!access.private) return { ok: false, code: "storePublic" };
        const backend = new github.GitHubBackend(ref.where.repo, {
          token,
          fetch,
          dir: ref.where.dir ?? "",
        });
        const manifest = await backend.manifest();
        if (!manifest) return { ok: false, code: "notStore" };
        if (manifest.id !== ref.id) return { ok: false, code: "wrongStore" };
        return { ok: true, store: remember({ id: ref.id, name: ref.name, kind: "github", where: { repo: ref.where.repo, dir: ref.where.dir ?? "" } }) }; // prettier-ignore
      } catch (err) {
        return failedHere(err);
      }
    }),
  );
  ipcMain.handle(
    "store:remove",
    appOnly((id) => {
      if (!find(id)) return false;
      service.forget(id);
      setList(registry.removeStore(list(), id));
      return true;
    }),
  );
  // Show where a store is: its folder in Finder/Explorer, its repository on
  // GitHub (with `people`, the page where who can reach it is managed).
  ipcMain.handle(
    "store:reveal",
    appOnly((id, { people = false } = {}) => {
      const store = find(id);
      if (!store) return false;
      if (store.kind === "folder") {
        // SHOWN in Finder/Explorer, never opened: opening a folder that is
        // really a package would run it.
        const manifest = path.join(store.where.path, "chiphippo-store.json");
        // Inside the folder's bookmark (a Mac App Store build cannot even
        // stat it without one after a relaunch).
        // Checked AND shown inside the folder's bookmark (a sandboxed build
        // may need the access held while Finder is asked).
        return deps.getBookmarks().withAccess(store.where.grant, () => {
          if (!fs.existsSync(manifest)) return false;
          shell.showItemInFolder(manifest);
          return true;
        }, { keep: true }); // prettier-ignore
      }
      const url = repoPage(store.where.repo, { access: people === true, dir: store.where.dir ?? "" }); // prettier-ignore
      if (!url) return false;
      shell.openExternal(url).catch(() => {});
      return true;
    }),
  );
  ipcMain.handle(
    "store:guide",
    appOnly((key) => {
      const url = guidePage(key);
      if (!url) return false;
      shell.openExternal(url).catch(() => {});
      return true;
    }),
  );

  // ── GitHub: the sign-in, the people ──
  /** The one sign-in under way: `{cancel, done}` — and a count, so a press
      superseded while GitHub was still answering it stands down. */
  let signIn = null;
  let signInSeq = 0;
  ipcMain.handle(
    "store:github-sign-in",
    appOnly(async () => {
      if (!clientId()) return { ok: false, code: "notConfigured" };
      if (!credentials().available()) return { ok: false, code: "noKeychain" };
      // One sign-in at a time: a second press (a double click) supersedes
      // the first, which must not go on polling unseen.
      signIn?.cancel();
      signIn = null;
      const mine = ++signInSeq;
      try {
        const flow = await github.startDeviceFlow({
          clientId: clientId(),
          fetch,
        });
        if (mine !== signInSeq) return { ok: false, code: "cancelled" };
        let cancelled = false;
        const session = {
          cancel: () => (cancelled = true),
          done: (async () => {
            const deadline = Date.now() + flow.expiresIn * 1000;
            let interval = flow.interval;
            while (!cancelled && Date.now() < deadline) {
              await sleep(interval * 1000);
              if (cancelled) break;
              let res;
              try {
                res = await github.pollDeviceFlow({ clientId: clientId(), deviceCode: flow.deviceCode, fetch }); // prettier-ignore
              } catch (err) {
                // A network blip is asked again at the next interval; a
                // refusal or an expired code ends it.
                if (err.code === "unavailable") continue;
                return failedHere(err.code === "denied" || err.code === "expired" ? { code: "signInDenied" } : err); // prettier-ignore
              }
              if (res.interval) interval = res.interval;
              if (!res.token) continue;
              // Cancelled while that poll was out: the token is not kept.
              if (cancelled) break;
              const saved = keepSignIn(res);
              if (!saved.ok) return { ok: false, code: "noKeychain" };
              let login = "";
              try {
                ({ login } = await github.whoAmI({ token: res.token, fetch }));
              } catch {
                /* signed in all the same */
              }
              deps.getSettingsStore().set({ githubLogin: login });
              return { ok: true, login };
            }
            return {
              ok: false,
              code: cancelled ? "cancelled" : "signInDenied",
            };
          })(),
        };
        signIn = session;
        return { ok: true, userCode: flow.userCode, verificationUri: flow.verificationUri, expiresIn: flow.expiresIn }; // prettier-ignore
      } catch (err) {
        return failedHere(err);
      }
    }),
  );
  ipcMain.handle(
    "store:github-sign-in-wait",
    appOnly(async () => {
      const session = signIn;
      if (!session) return { ok: false, code: "unavailable" };
      const res = await session.done;
      if (signIn === session) signIn = null;
      return res;
    }),
  );
  ipcMain.handle(
    "store:github-sign-in-cancel",
    appOnly(() => {
      // A start still waiting on GitHub stands down when it arrives (the
      // count moves on), and one already polling stops.
      signInSeq += 1;
      signIn?.cancel();
      return true;
    }),
  );
  ipcMain.handle(
    "store:github-sign-out",
    appOnly(() => {
      credentials().clear("github");
      deps.getSettingsStore().set({ githubLogin: "" });
      return true;
    }),
  );
  // The private repositories the account can write to — "Use one of my
  // repositories" (github.js `listRepos`).
  ipcMain.handle(
    "store:github-repos",
    appOnly(async () => {
      const t = token();
      if (!t) return { ok: false, code: "signedOut" };
      try {
        return { ok: true, ...(await github.listRepos({ token: t, fetch })) };
      } catch (err) {
        return failedHere(err);
      }
    }),
  );
  ipcMain.handle(
    "store:invite",
    appOnly(async (id, login) => {
      const store = find(id);
      if (!store || store.kind !== "github")
        return { ok: false, code: "invalid" };
      const t = token();
      if (!t) return { ok: false, code: "signedOut" };
      try {
        const result = await github.inviteFriend({ token: t, repo: store.where.repo, login: String(login ?? "").trim().replace(/^@/, ""), fetch }); // prettier-ignore
        return { ok: true, result };
      } catch (err) {
        return failedHere(err);
      }
    }),
  );
  ipcMain.handle(
    "store:people",
    appOnly(async (id) => {
      const store = find(id);
      if (!store || store.kind !== "github")
        return { ok: false, code: "invalid" };
      const t = token();
      if (!t) return { ok: false, code: "signedOut" };
      try {
        return { ok: true, ...(await github.storePeople({ token: t, repo: store.where.repo, fetch })) }; // prettier-ignore
      } catch (err) {
        return failedHere(err);
      }
    }),
  );

  return { grants: () => registry.storeGrants(list()) };
}

module.exports = { CODES, registerStoresIpc };
