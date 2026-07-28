/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Whether the toolbar's AI segment has a connection to offer. The rule that
// matters most is the one the segment exists for: no key, no button.

import test from "node:test";
import assert from "node:assert/strict";

import { checkConnection, effectiveProvider } from "../ai/connection.js";

const PROVIDERS = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai-compat", label: "OpenAI-compatible" },
];
const STORED = { configured: true, encryptionAvailable: true };
const ABSENT = { configured: false, encryptionAvailable: true };

test("a stored key for the chosen provider is a usable connection", () => {
  const r = checkConnection({ provider: "anthropic" }, PROVIDERS, STORED);
  assert.equal(r.ok, true);
  assert.equal(r.reason, "");
});

test("blank base URL and model are the provider's defaults, not a fault", () => {
  const config = { provider: "anthropic", baseUrl: "", model: "" };
  assert.equal(checkConnection(config, PROVIDERS, STORED).ok, true);
});

test("no key configured disables the builder, and says why", () => {
  const r = checkConnection({ provider: "anthropic" }, PROVIDERS, ABSENT);
  assert.equal(r.ok, false);
  assert.match(r.reason, /No API key is configured for Anthropic/);
  assert.match(r.reason, /Settings/);
});

test("a missing key status reads as no key — never as ready", () => {
  assert.equal(
    checkConnection({ provider: "anthropic" }, PROVIDERS, null).ok,
    false,
  );
});

test("no OS credential store is reported as its own reason", () => {
  const r = checkConnection({ provider: "anthropic" }, PROVIDERS, {
    configured: false,
    encryptionAvailable: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no secure credential store/);
});

test("a provider this build has no adapter for is refused, not swapped", () => {
  const r = checkConnection({ provider: "gemini" }, PROVIDERS, STORED);
  assert.equal(r.ok, false);
  assert.match(r.reason, /gemini/);
  assert.equal(effectiveProvider({ provider: "gemini" }, PROVIDERS), null);
});

test("an unset provider falls back to the first, exactly as the picker does", () => {
  assert.equal(effectiveProvider({}, PROVIDERS).id, "anthropic");
  assert.equal(checkConnection({}, PROVIDERS, STORED).ok, true);
});

test("a build with no providers at all offers nothing", () => {
  const r = checkConnection({ provider: "anthropic" }, [], STORED);
  assert.equal(r.ok, false);
  assert.match(r.reason, /No AI provider/);
});

test("a typed base URL must be an address that could be reached", () => {
  const bad = { provider: "anthropic", baseUrl: "localhost:11434" };
  const r = checkConnection(bad, PROVIDERS, STORED);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a valid http\(s\) address/);

  const good = { provider: "anthropic", baseUrl: "http://localhost:11434/v1" };
  assert.equal(checkConnection(good, PROVIDERS, STORED).ok, true);
});
