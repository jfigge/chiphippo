// eslint.config.js — ESLint 9 flat configuration for Chip Hippo
"use strict";

const js = require("@eslint/js");
const globals = require("globals");

// `make lint` invokes this from the REPO ROOT (see ../Makefile), not from
// here, so that ESLint's base path covers both this package (src/) and the
// sibling ../scripts/ build tooling in one run — a file outside ESLint's base
// path is silently skipped with no error, which is exactly how the
// build-tooling scripts went unlinted (and a real duplicate-key bug shipped)
// before this config existed. Each block below anchors its own `files`
// patterns back to THIS file's directory via `basePath: "src"` so they still
// read exactly as they did under the old `cd src && eslint web/... app/...`
// invocation; the scripts/ block has no override, so it resolves against the
// invocation's own repo-root base path instead.
module.exports = [
  // ── Ignore vendored third-party bundles ────────────────────────────────────
  // web/scripts/vendor/markdown.js is esbuild's bundled marked + DOMPurify
  // (Feature 230) — generated output, never hand-edited, never linted.
  {
    basePath: "src",
    ignores: ["web/scripts/vendor/**"],
  },
  // ── Ignore the site's GENERATED trees ───────────────────────────────────────
  // website/desktop/ is a built web app (make web, or the deploy's unpacked
  // release) and website/gallery/lib/ is scripts/build-gallery.mjs's copy of
  // src/web/scripts/gallery/ — both git-ignored, both linted at their source.
  {
    ignores: ["website/desktop/**", "website/gallery/lib/**"],
  },

  // ── Renderer / browser scripts ─────────────────────────────────────────────
  {
    basePath: "src",
    files: ["web/scripts/**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },

  // Tests run under Node's test runner (node --test), not a real browser —
  // they need Node globals (`global`, `process`, …) ON TOP OF the browser
  // globals above (jsdom simulates the DOM inside that same Node process).
  // The engine benchmark (`make bench`) runs the same way.
  {
    basePath: "src",
    files: ["web/scripts/tests/**/*.js", "web/scripts/bench/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // ── Electron main-process / app scripts ────────────────────────────────────
  {
    basePath: "src",
    files: ["app/**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },

  // preload.js runs in Electron's isolated preload context which — unlike the
  // rest of the main process — has a real `window` (the renderer's own DOM).
  {
    basePath: "src",
    files: ["app/preload.js"],
    languageOptions: {
      globals: {
        window: "readonly",
      },
    },
  },

  // ── The web build's host (src/web-host/, .claude/rules/web.md) ──────────────
  // Browser ES modules that stand in for Electron and Node under main's own
  // code; esbuild bundles them (scripts/build-web.mjs), which is why the two
  // entry points may `require()` main's CommonJS. The service worker has its
  // own globals and the BUILD constant the build prepends; the tests run
  // under Node.
  {
    basePath: "src",
    files: ["web-host/**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    basePath: "src",
    files: ["web-host/host-entry.js", "web-host/renderer/preload-entry.js"],
    languageOptions: { globals: { require: "readonly" } },
  },
  {
    basePath: "src",
    files: ["web-host/sw.js"],
    languageOptions: {
      globals: { ...globals.serviceworker, BUILD: "readonly" },
    },
  },
  {
    basePath: "src",
    files: ["web-host/tests/**/*.js"],
    languageOptions: { globals: { ...globals.node } },
  },

  // ── The marketing site (website/*.js, outside src/) ────────────────────────
  // Classic browser IIFEs served as plain <script src> off a static page (and
  // app/sw.js, the worker retiring the web app's old home): no modules, no
  // bundler, no bridge, so `sourceType: "script"` and browser globals with
  // nothing else. They were unlinted and unformatted until now for
  // the same reason scripts/ was — outside the invocation's base path, silently
  // skipped — and that is exactly where five of the seven bugs in this area
  // lived. Their tests are src/web/scripts/tests/website-*.test.js, which the
  // renderer blocks above already cover.
  {
    files: ["website/**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },

  // ── The gallery page (website/gallery/*.js) ────────────────────────────────
  // The one website script that is an ES MODULE: it imports the shared grid
  // from lib/ (src/web/scripts/gallery/, copied by scripts/build-gallery.mjs).
  {
    files: ["website/gallery/*.js"],
    languageOptions: { sourceType: "module" },
  },

  // ── Services (services/*/, outside src/) ──────────────────────────────────
  // The gallery's submission service: a Cloudflare Worker, ES modules on the
  // Web platform (fetch, Request, Response, crypto.subtle), its tests under
  // node --test.
  {
    files: ["services/**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.serviceworker,
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },

  // ── Build/dev tooling (scripts/*.mjs, outside src/) ─────────────────────────
  // Plain Node ESM scripts (some run under Electron via `npx electron
  // scripts/*.mjs`, but as far as syntax/globals go they're just Node).
  {
    files: ["scripts/**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
];
