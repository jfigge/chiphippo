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

// Where an AI base URL may send the stored API key (ai/base-url.js) — the rule
// main enforces in app/ai/providers.js and the renderer mirrors.

import test from "node:test";
import assert from "node:assert/strict";

import {
  baseUrlProblem,
  isKnownAiHost,
  isLoopbackHost,
} from "../ai/base-url.js";

test("https anywhere is allowed", () => {
  assert.equal(baseUrlProblem("https://api.anthropic.com"), null);
  assert.equal(baseUrlProblem("https://openrouter.ai/api"), null);
});

test("plain http is allowed only to this machine", () => {
  assert.equal(baseUrlProblem("http://localhost:11434"), null);
  assert.equal(baseUrlProblem("http://127.0.0.1:1234/v1"), null);
  assert.equal(baseUrlProblem("http://[::1]:8080"), null);
  assert.equal(baseUrlProblem("http://192.168.1.20:11434"), "insecure");
  assert.equal(baseUrlProblem("http://api.anthropic.com"), "insecure");
  // A lookalike is not loopback.
  assert.equal(baseUrlProblem("http://localhost.example.com"), "insecure");
  assert.equal(baseUrlProblem("http://127.0.0.1.example.com"), "insecure");
});

test("anything that is not an http(s) URL is refused", () => {
  assert.equal(baseUrlProblem("file:///etc"), "scheme");
  assert.equal(baseUrlProblem("javascript:alert(1)"), "scheme");
  assert.equal(baseUrlProblem("not a url"), "invalid");
  assert.equal(baseUrlProblem(""), "invalid");
});

test("known hosts are the providers' own APIs and this machine", () => {
  assert.equal(isKnownAiHost("https://api.anthropic.com/v1"), true);
  assert.equal(isKnownAiHost("https://API.OpenAI.com"), true);
  assert.equal(isKnownAiHost("http://localhost:11434"), true);
  assert.equal(isKnownAiHost("https://proxy.example.com"), false);
  assert.equal(isKnownAiHost("https://api.anthropic.com.evil.example"), false);
  assert.equal(isKnownAiHost("junk"), false);
  assert.equal(isLoopbackHost("LOCALHOST"), true);
  assert.equal(isLoopbackHost("example.com"), false);
});
