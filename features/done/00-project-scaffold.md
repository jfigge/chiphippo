# Feature 00 — Project scaffold & build system

## Context
The repo currently holds only this `features/` folder and a `README.md`. Everything
else must be created. This stage stands up the **skeleton** every later stage builds
on, copying the proven engineering setup shared by Rest Hippo
(`/Users/jason/src/js/projects/resthippo`) and Port Hippo
(`/Users/jason/src/js/projects/porthippo`) — Port Hippo's
`features/done/00-project-scaffold.md` is the closest precedent, since Port Hippo was
itself scaffolded as a sibling. Strip it to a Chip-Hippo-sized shell: no SSH/REST
domain code, no tray, no i18n catalogs yet.

There are no breadboards, components, or simulation in this stage — just a launchable
Electron window with an empty desk placeholder and a working `window.chiphippo` IPC
bridge, so `make debug` opens the app and the toolchain (`fmt`/`lint`/`test`/`build`)
is green from commit one.

## Goal
A cloneable repo where `make install` then `make debug` launches a Chip Hippo Electron
window showing a header bar and an empty desk area, `make build` produces an unsigned
macOS app bundle, and `make fmt && make lint && make test` all pass — with the
license-header guard already wired.

## Design decisions (settled — do not relitigate)
- **Mirror the siblings' structure exactly** where it isn't domain-specific: top-level
  `Makefile`; `src/package.json` (deps + electron-builder `build` block); `src/app`
  (main, CommonJS) / `src/web` (renderer, ES modules) split; `scripts/` for tooling;
  `data/` as the git-ignored dev `--user-data-dir`. Do **not** copy either sibling's
  domain code or their release/sign/store Make targets.
- **No UI framework, ever.** Vanilla ES2022 modules + plain CSS custom properties.
  This is a hard, permanent constraint carried in `CLAUDE.md`.
- **Electron 42+**, Node ≥20 engine. Window hardening from day one:
  `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a
  `setWindowOpenHandler` that only passes http/https/mailto to `shell.openExternal`.
- **IPC namespace is `window.chiphippo`.** One preload bridge; `main.js` handlers and
  `preload.js` exports stay in lockstep (the parity test lands in Feature 20 once
  there are channels worth checking — for now the bridge exposes `platform`, `arch`,
  and `getVersion`).
- **Apache-2.0 from day one**, with the license-header guard
  (`scripts/license-header.mjs` + `make test-license-headers`) ported verbatim from
  Port Hippo and pointed at `src/app`, `src/web/scripts`, `src/web/styles`, and
  `scripts/`.
- **Tooling: ESLint 9 flat config + Prettier**, Node built-in test runner
  (`node --test`), `jsdom` as a devDependency for later renderer-component tests. No
  Jest/Mocha/webpack; no bundler for app code.
- **Window close quits the app** (normal Electron default). No tray — Chip Hippo is a
  foreground document app, unlike Port Hippo.

## Implementation steps
1. **Repo metadata & ignore.** Root `LICENSE` (Apache-2.0) and `NOTICE`; `.gitignore`
   covering `src/node_modules/`, `build/`, `dist/`, `data/`, `*.env` (keep
   `*.env.example`), `.DS_Store`. Add `dev.env.example` (empty scaffold for the shared
   dev-env pattern) and `CLAUDE.md` (step 8).
2. **`src/package.json`.** `name: chiphippo`, `version: 0.1.0`, `main: app/main.js`,
   `license: Apache-2.0`, author Jason Figge, `homepage`/`repository`
   `github.com/jfigge/chiphippo`, `engines.node >=20`. Scripts: `start`, `dev`, `fmt`,
   `lint` (paths `web/scripts/**/*.js` + `app/**/*.js`), `test`. devDependencies:
   `electron`, `electron-builder`, `eslint`, `globals`, `prettier`, `jsdom`.
   dependencies: empty for now. electron-builder `build` block scaffold (appId
   `com.chiphippo.app`, productName `Chip Hippo`, `directories.output: dist`, `files`
   globbing `app/**` + `web/**` + `package.json`) — the full multi-platform matrix
   waits for the packaging backlog stage.
3. **Makefile.** Port the sibling Makefile's *structure* (VERSION/COMMIT/BRANCH vars,
   `WORKSPACE`/`SRC_DIR`/`BUILD_DIR`/`DATA_DIR`, `dev.env` include+export,
   `.DEFAULT_GOAL := dmg`) and these targets only: `install` (`npm ci`), `debug`
   (`electron app/main.js --hot-reload --user-data-dir=$(DATA_DIR)`), `fmt`,
   `fmt-check`, `lint`, `license-headers`, `test-license-headers`, `test`,
   `build`/`build-mac` (electron-builder `--dir` unsigned via the rsync-to-`build/src`
   flow), `dmg`, `clean`, `version`, `info`, `help`.
4. **Main process shell (`src/app/main.js`).** Create the hardened `BrowserWindow`
   (min 1024×640, `backgroundColor` matching the theme base), load `web/index.html`,
   DevTools + `fs.watch`-based hot reload under `--hot-reload`, single-instance lock,
   standard `window-all-closed`/`activate` lifecycle. IPC handlers: `app:platform`,
   `app:version`.
5. **Preload bridge (`src/app/preload.js`).**
   `contextBridge.exposeInMainWorld("chiphippo", { platform, arch, getVersion })`,
   invoke-backed. This is the single seam every later stage extends. Include the
   sibling's warning comment: sandboxed preload may only require Electron built-ins.
6. **Renderer shell (`src/web`).** `index.html` with a `script-src 'self'` CSP,
   loading `styles/theme.css`, `styles/app.css`, `scripts/app.js` (module);
   `src/web/scripts/package.json` = `{ "type": "module" }`. `theme.css` carries the
   design-token starter set (color, spacing, radius, font vars — dark default +
   light via `prefers-color-scheme` gated by `:root:not([data-theme])`, plus explicit
   `[data-theme="light"|"dark"]` overrides). `app.js` mounts a header bar (app name,
   empty toolbar slot) above a full-bleed empty `.desk-viewport` section showing a
   centered muted hint ("Add a breadboard to get started" — inert for now). Bundle the
   Inter variable font under `src/web/fonts/` (no CDN). Add `src/web/chiphippo-icon.svg`
   (simple placeholder; a hippo + DIP-chip motif is welcome).
7. **License-header tooling.** Port `scripts/license-header.mjs` (stamp + `--check`)
   with `ROOTS` = `src/app`, `src/web/scripts`, `src/web/styles`, `scripts`; stamp
   every file created above.
8. **`CLAUDE.md`.** Modelled on Port Hippo's: what the app is, naming/identity block
   (from `ROADMAP.md`), the `src/app`/`src/web` split, key entry points, common `make`
   commands, the no-framework + class-naming + IPC-lockstep + pure-logic/DOM-split +
   pointer-drag + Apache-header rules, the domain vocabulary (pitch units, board
   types, address scheme — copy the ROADMAP "Domain reference" section), and the git
   workflow ("solo project, commit on `main`, never auto-branch, Claude drafts but
   never commits/pushes unless asked").
9. **Smoke test.** One trivial `node --test` unit (e.g. a pure helper under
   `src/app`) so `make test` exercises the runner; confirm clean
   `make lint && make fmt-check`.

## Acceptance criteria
- `make install && make debug` opens a Chip Hippo window with the header + empty desk
  hint and no console errors.
- The renderer can call `window.chiphippo.platform` / `.getVersion()` and get real
  values over IPC.
- `make build` (or `make dmg`) produces an unsigned macOS artifact under
  `build/src/dist/`.
- `make fmt-check`, `make lint`, and `make test` (including `test-license-headers`)
  all pass; every first-party file carries the Apache-2.0 header.
- `CLAUDE.md`, `LICENSE`, `NOTICE`, `.gitignore`, and `dev.env.example` exist and are
  consistent with the naming in `ROADMAP.md`.

## Constraints
- No framework, no bundler-built renderer (plain `<script type="module">`), no CDN
  fonts/assets. Native I/O only in main; renderer only via `window.chiphippo.*`.
- Do not port either sibling's domain code, i18n catalogs, tray, or release/store
  Make targets.
- CSS via `theme.css` tokens; class naming `prefix-name` / `block--modifier`.
- Keep `main.js` handlers and `preload.js` exports in lockstep.

## Verify
`make install`, then `make fmt-check && make lint && make test` (all green). Run
`make debug`: window opens with header + desk hint; DevTools shows
`window.chiphippo.platform` returning your OS. Run `make build` and confirm an
unsigned app bundle under `build/src/dist/`. Finally `make clean` removes artifacts.
