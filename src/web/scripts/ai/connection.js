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

// connection.js — is there a connection to ask at all? (Feature 260).
//
// The toolbar's AI segment is only offered when the answer is yes, so this is
// the one place that decides it. Pure and DOM-free: it is handed the settings'
// non-secret `ai` config, the provider list main answered `ai:providers` with,
// and the `{configured, encryptionAvailable}` that `ai:key:status` reports —
// never a key, which does not cross the bridge.
//
// "VALID" IS DECIDED WITHOUT ASKING THE PROVIDER. Chip Hippo sends nothing
// anywhere until the user asks it to build something, so readiness must not be
// a network call fired at launch: what is checkable here is that a key IS
// stored for the CHOSEN provider, that the provider is one this build actually
// has an adapter for, and that a base URL the user typed is an address that
// could be reached. A key that is stored but rejected by the server is the one
// thing only the server can say — Settings ▸ AI's Test connection is where that
// is found, and a failing build reports it.
//
// Every refusal carries the sentence the disabled button shows as its tooltip:
// a control that is greyed out has to say why, or it reads as broken.

/**
 * The provider a connection actually speaks to, or null when settings name one
 * this build has no adapter for.
 *
 * Settings ▸ AI's picker falls back to the FIRST provider when nothing is
 * chosen yet, so readiness has to read it the same way — otherwise the button
 * would be dead while the panel showed a perfectly good connection. A provider
 * that is named but unknown is NOT folded into that fallback: silently asking
 * a different service than the one configured is worse than saying so.
 *
 * @param {{provider?:string}} config
 * @param {Array<{id:string, label?:string}>} providers
 * @returns {{id:string, label?:string}|null}
 */
import { tf } from "../i18n.js";

export function effectiveProvider(config, providers) {
  const list = Array.isArray(providers) ? providers : [];
  if (!config?.provider) return list[0] ?? null;
  return list.find((p) => p.id === config.provider) ?? null;
}

/**
 * Whether the app has everything it needs to ask a provider for a circuit.
 *
 * @param {{provider?:string, baseUrl?:string, model?:string}} config the
 *   `settings.ai` block (all three fields optional — a blank base URL or model
 *   means "use the provider's default", which is a valid connection).
 * @param {Array<{id:string, label?:string}>} providers what `ai:providers`
 *   answered; an empty list means this build has no adapters at all.
 * @param {{configured?:boolean, encryptionAvailable?:boolean}|null} keyStatus
 *   what `ai:key:status` answered for `config.provider`.
 * @returns {{ok:boolean, reason:string}} `reason` is empty when ok, and
 *   otherwise a complete sentence naming what to do about it.
 */
export function checkConnection(config, providers, keyStatus) {
  const list = Array.isArray(providers) ? providers : [];
  if (!list.length) {
    return { ok: false, reason: tf("ai.reason.noProvider", "No AI provider is available in this build.") }; // prettier-ignore
  }

  const chosen = effectiveProvider(config, list);
  if (!chosen) {
    return {
      ok: false,
      reason: tf(
        "ai.reason.unknownProvider",
        "“{provider}” is not a provider this build can reach. Choose one in Settings ▸ AI.",
        { provider: config.provider },
      ),
    };
  }
  const label = chosen.label ?? chosen.id;

  if (keyStatus?.encryptionAvailable === false) {
    return {
      ok: false,
      reason: tf(
        "ai.reason.noSecureStore",
        "This system has no secure credential store, so an API key cannot be saved. See Settings ▸ AI.",
      ),
    };
  }
  if (!keyStatus?.configured) {
    return {
      ok: false,
      reason: tf(
        "ai.reason.noKey",
        "No API key is configured for {provider}. Add one in Settings ▸ AI.",
        { provider: label },
      ),
    };
  }

  // A blank base URL is the provider's own default and always fine; a typed one
  // has to be an address the client could actually open.
  const baseUrl =
    typeof config?.baseUrl === "string" ? config.baseUrl.trim() : "";
  if (baseUrl && !isHttpUrl(baseUrl)) {
    return {
      ok: false,
      reason: tf(
        "ai.reason.badBaseUrl",
        "The AI base URL “{url}” is not a valid http(s) address. Fix or clear it in Settings ▸ AI.",
        { url: baseUrl },
      ),
    };
  }

  return { ok: true, reason: "" };
}

/** Whether a string parses as an absolute http/https URL. */
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
