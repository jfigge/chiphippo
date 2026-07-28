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

// credential-store.js — the ONE place a secret lives (Feature 260).
//
// The app ships no credentials and calls nothing on its own; an AI connection
// exists only because the user pasted their own API key. That key is the first
// secret this app has ever held, so it gets its own store rather than a corner
// of settings.json — because settings.json is plaintext, mode 0644, and is
// handed BACK to the renderer in full on every `settings:get`. A key stored
// there would be readable on disk and re-seeded into the Settings dialog on
// every open.
//
// Instead: Electron's `safeStorage`, which encrypts against the OS keychain
// (Keychain on macOS, libsecret/kwallet on Linux, DPAPI on Windows), written
// atomically through the same io.js primitives every other store uses.
//
// TWO RULES, both about not lying to the user:
//
//   1. If encryption is unavailable, REFUSE — never silently fall back to
//      plaintext. A user who was told their key is stored securely should not
//      have it sitting in a readable file because a Linux box had no keyring.
//   2. A stored key NEVER comes back out across the IPC bridge. `status()`
//      answers whether one is configured; only the main-process AI client
//      reads the value, and only to put it in an outgoing request header.

const path = require("path");

const io = require("./io");

/** Provider ids we will store a key for — an allowlist, not free-form. */
const PROVIDERS = Object.freeze(["anthropic", "openai-compat"]);

class CredentialStore {
  /**
   * @param {string} dataDir - the app's userData directory.
   * @param {{isEncryptionAvailable:Function, encryptString:Function,
   *          decryptString:Function}} safeStorage - Electron's safeStorage
   *   (injected so this is testable without an Electron runtime).
   */
  constructor(dataDir, safeStorage) {
    this._file = path.join(dataDir, "credentials.json");
    this._safe = safeStorage ?? null;
  }

  /** Whether the OS can encrypt for us at all. */
  available() {
    try {
      return Boolean(this._safe?.isEncryptionAvailable?.());
    } catch {
      return false;
    }
  }

  _read() {
    const doc = io.readJSON(this._file);
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  }

  /**
   * Store a provider's key, encrypted.
   *
   * @returns {{ok:true}|{ok:false, error:string}}
   */
  set(providerId, key) {
    if (!PROVIDERS.includes(providerId)) {
      return { ok: false, error: `Unknown provider "${providerId}".` };
    }
    if (typeof key !== "string" || !key.trim()) {
      return { ok: false, error: "The key is empty." };
    }
    if (!this.available()) {
      return {
        ok: false,
        error:
          "This system has no secure credential store available, so the key " +
          "cannot be saved. Set it again next session, or configure an OS " +
          "keyring.",
      };
    }
    let encrypted;
    try {
      encrypted = this._safe.encryptString(key.trim()).toString("base64");
    } catch (err) {
      return { ok: false, error: `Could not encrypt the key: ${err.message}` };
    }
    const next = { ...this._read(), [providerId]: encrypted };
    io.writeJSON(this._file, next);
    return { ok: true };
  }

  /**
   * The decrypted key, or null. MAIN-PROCESS ONLY — this value must never be
   * returned over an IPC channel; see the header note.
   *
   * @returns {string|null}
   */
  get(providerId) {
    const stored = this._read()[providerId];
    if (typeof stored !== "string" || !stored) return null;
    if (!this.available()) return null;
    try {
      const plain = this._safe.decryptString(Buffer.from(stored, "base64"));
      return typeof plain === "string" && plain ? plain : null;
    } catch {
      // A key encrypted under a keychain we can no longer open (a restored
      // machine, a changed login) is gone, not recoverable — say "not
      // configured" rather than throwing on every request.
      return null;
    }
  }

  /** Forget a provider's key. */
  clear(providerId) {
    const doc = this._read();
    if (!(providerId in doc)) return { ok: true };
    delete doc[providerId];
    io.writeJSON(this._file, doc);
    return { ok: true };
  }

  /**
   * What the renderer is allowed to know: whether a key is there, never what
   * it is.
   *
   * @returns {{configured:boolean, encryptionAvailable:boolean}}
   */
  status(providerId) {
    return {
      configured: Boolean(this.get(providerId)),
      encryptionAvailable: this.available(),
    };
  }
}

module.exports = { CredentialStore, PROVIDERS };
