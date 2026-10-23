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

// base-url.js — where an AI base URL may send the stored API key. Pure and
// dependency-free, because it is read from BOTH sides of the bridge (as
// model/serial-wire.js is):
//
//   · main's app/ai/providers.js `require()`s it (require(esm)) and REFUSES a
//     request to an address that fails it — main holds the key, so main is
//     the authority;
//   · the renderer's ai/connection.js greys the toolbar's AI segment by the
//     same rule, and Settings ▸ AI marks the field with it.
//
// THE RULE: https, or plain http to THIS machine only. The key travels in a
// request header, so plain http to anywhere else hands it to every hop on the
// way; a local Ollama or LM Studio (the OpenAI-compatible default is
// http://localhost:11434) never leaves the machine, so it stays allowed.
//
// A host this build does not KNOW (not the two providers' own APIs, not this
// machine) is legal — a proxy or OpenRouter is a real use — but the key goes
// there too, so Settings says so beside the field.

/** The providers' own API hosts — what a key is MEANT to be sent to. */
export const KNOWN_AI_HOSTS = Object.freeze([
  "api.anthropic.com",
  "api.openai.com",
]);

/** Whether a URL's hostname is this machine (`localhost`, 127/8, ::1). */
export function isLoopbackHost(hostname) {
  const host = String(hostname ?? "")
    .toLowerCase()
    .replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * What is wrong with a base URL, or null when a key may be sent there.
 *
 * @param {string} value - an absolute URL (callers pass the default for blank).
 * @returns {null|"invalid"|"scheme"|"insecure"} `invalid`: not a URL at all;
 *   `scheme`: not http(s); `insecure`: plain http to another machine.
 */
export function baseUrlProblem(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    return "invalid";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol !== "http:") return "scheme";
  return isLoopbackHost(url.hostname) ? null : "insecure";
}

/** Whether a (legal) base URL's host is one a key is meant for: a provider's
    own API, or this machine. False for anything unparseable. */
export function isKnownAiHost(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return KNOWN_AI_HOSTS.includes(host) || isLoopbackHost(host);
}
