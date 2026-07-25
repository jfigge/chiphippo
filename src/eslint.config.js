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
  {
    basePath: "src",
    files: ["web/scripts/tests/**/*.js"],
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
