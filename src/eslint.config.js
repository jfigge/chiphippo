// eslint.config.js — ESLint 9 flat configuration for Chip Hippo
"use strict";

const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  // ── Renderer / browser scripts ─────────────────────────────────────────────
  {
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
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },

  // ── Electron main-process / app scripts ────────────────────────────────────
  {
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
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
];
