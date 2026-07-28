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

// The credential store's promises are about not lying to the user: a key is
// either encrypted or refused (never quietly written in the clear), and what is
// stored never comes back out except to main itself.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { CredentialStore } = require("../store/credential-store");

/** A stand-in for Electron's safeStorage — reversible, obviously not secure. */
const fakeSafe = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`enc:${s}`, "utf8"),
  decryptString: (buf) => {
    const s = buf.toString("utf8");
    if (!s.startsWith("enc:")) throw new Error("not ours");
    return s.slice(4);
  },
});

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-cred-"));

test("a key round-trips through the OS store", () => {
  const dir = tmpDir();
  const store = new CredentialStore(dir, fakeSafe());
  assert.deepEqual(store.status("anthropic"), {
    configured: false,
    encryptionAvailable: true,
  });

  assert.deepEqual(store.set("anthropic", "sk-secret"), { ok: true });
  assert.equal(store.get("anthropic"), "sk-secret");
  assert.equal(store.status("anthropic").configured, true);
});

test("the plaintext key is never written to disk", () => {
  const dir = tmpDir();
  const store = new CredentialStore(dir, fakeSafe());
  store.set("anthropic", "sk-super-secret-value");
  const onDisk = fs.readFileSync(path.join(dir, "credentials.json"), "utf8");
  assert.equal(
    onDisk.includes("sk-super-secret-value"),
    false,
    "the raw key must not appear in the file",
  );
});

test("with no OS encryption it REFUSES rather than falling back to plaintext", () => {
  const dir = tmpDir();
  const store = new CredentialStore(dir, fakeSafe(false));
  const r = store.set("anthropic", "sk-secret");
  assert.equal(r.ok, false);
  assert.match(r.error, /secure credential store/i);
  assert.equal(
    fs.existsSync(path.join(dir, "credentials.json")),
    false,
    "nothing was written at all",
  );
  assert.equal(store.status("anthropic").encryptionAvailable, false);
});

test("a key that can no longer be decrypted reads as absent, not as a crash", () => {
  // A restored machine or a changed login leaves ciphertext this keychain
  // cannot open. That is "not configured", not an exception on every request.
  const dir = tmpDir();
  new CredentialStore(dir, fakeSafe()).set("anthropic", "sk-old");
  fs.writeFileSync(
    path.join(dir, "credentials.json"),
    JSON.stringify({ anthropic: Buffer.from("garbage").toString("base64") }),
  );
  const store = new CredentialStore(dir, fakeSafe());
  assert.equal(store.get("anthropic"), null);
  assert.equal(store.status("anthropic").configured, false);
});

test("clearing forgets the key and is idempotent", () => {
  const dir = tmpDir();
  const store = new CredentialStore(dir, fakeSafe());
  store.set("anthropic", "sk-secret");
  assert.deepEqual(store.clear("anthropic"), { ok: true });
  assert.equal(store.get("anthropic"), null);
  assert.deepEqual(
    store.clear("anthropic"),
    { ok: true },
    "clearing twice is fine",
  );
});

test("providers are an allowlist and empty keys are refused", () => {
  const dir = tmpDir();
  const store = new CredentialStore(dir, fakeSafe());
  assert.equal(store.set("evil-corp", "sk-x").ok, false);
  assert.equal(store.set("anthropic", "").ok, false);
  assert.equal(store.set("anthropic", "   ").ok, false);
});

test("providers do not share a slot", () => {
  const dir = tmpDir();
  const store = new CredentialStore(dir, fakeSafe());
  store.set("anthropic", "sk-a");
  store.set("openai-compat", "sk-b");
  assert.equal(store.get("anthropic"), "sk-a");
  assert.equal(store.get("openai-compat"), "sk-b");
  store.clear("anthropic");
  assert.equal(
    store.get("openai-compat"),
    "sk-b",
    "clearing one leaves the other",
  );
});

test("a missing or corrupt file is not fatal", () => {
  const dir = tmpDir();
  const store = new CredentialStore(dir, fakeSafe());
  assert.equal(store.get("anthropic"), null, "no file yet");
  fs.writeFileSync(path.join(dir, "credentials.json"), "{ not json");
  assert.equal(store.get("anthropic"), null);
  assert.deepEqual(
    store.set("anthropic", "sk-new"),
    { ok: true },
    "and recovers",
  );
  assert.equal(store.get("anthropic"), "sk-new");
});

test("with no safeStorage at all nothing is stored", () => {
  const dir = tmpDir();
  const store = new CredentialStore(dir, null);
  assert.equal(store.available(), false);
  assert.equal(store.set("anthropic", "sk").ok, false);
  assert.equal(store.get("anthropic"), null);
});
