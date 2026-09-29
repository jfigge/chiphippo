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

// client.js — the app's only outbound network call (Feature 260).
//
// It lives in MAIN because it has to: the renderer's CSP is `default-src
// 'self'` with no `connect-src`, so a fetch from there is refused outright.
// That is the same rule that puts every filesystem call in main, and it is
// worth keeping — the renderer stays a thing that cannot phone home.
//
// Node's global `fetch` rather than an HTTP dependency: an SSE reader is a few
// dozen lines, and the only runtime packages the app ships are the updater and
// the serial port. The trade is typed helpers we do not get.
//
// Requests are registered by id so a long generation can be cancelled — the
// renderer holds the id, and `cancel(id)` aborts the underlying fetch. Nothing
// here parses a netlist: this streams text out and the renderer decides what it
// means, so a provider change never touches the compiler.

const { providerFor } = require("./providers");

/** In-flight requests, id → AbortController. */
const inflight = new Map();
let seq = 0;

/**
 * Read an SSE body, handing each parsed `data:` payload to `onEvent`.
 *
 * Server-sent events are newline-delimited and a chunk boundary can fall
 * anywhere, so the tail of each chunk is carried forward rather than parsed —
 * splitting on "\n\n" per-chunk silently drops events that straddle a boundary,
 * which shows up as text going missing under load rather than as an error.
 */
async function readSSE(body, onEvent) {
  const decoder = new TextDecoder();
  let buffer = "";
  const frameOut = (frame) => {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") {
        if (payload === "[DONE]") onEvent({ done: true }, true);
        continue;
      }
      try {
        onEvent(JSON.parse(payload), false);
      } catch {
        /* a partial or non-JSON frame — the next one will carry the text */
      }
    }
  };
  // The spec lets a line end in CRLF, CR or LF, and some servers use CRLF
  // (sse-starlette, which llama-cpp-python's OpenAI-compatible server runs
  // on): "\r\n\r\n" never contains "\n\n", so a CRLF stream produced not
  // one event and ended as an "empty response". Line endings are normalised
  // as the text arrives — holding back a trailing CR, which may be the first
  // half of a CRLF split across two chunks.
  const take = (text) => {
    buffer += text;
    const held = buffer.endsWith("\r") ? "\r" : "";
    if (held) buffer = buffer.slice(0, -1);
    buffer = buffer.replace(/\r\n?/g, "\n");
    let cut;
    while ((cut = buffer.indexOf("\n\n")) !== -1) {
      frameOut(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 2);
    }
    buffer += held;
  };
  for await (const chunk of body) {
    take(decoder.decode(chunk, { stream: true }));
  }
  // Whatever the decoder still holds, and a last frame the server closed the
  // stream on without its blank line, are events too.
  take(decoder.decode());
  if (buffer.trim()) frameOut(buffer.replace(/\r\n?/g, "\n"));
}

/** A human-readable reason for a non-2xx response. */
function describeStatus(status, text) {
  if (status === 401 || status === 403) {
    return "The provider rejected the API key. Check it in Settings ▸ AI.";
  }
  if (status === 404) {
    return "The endpoint was not found — check the base URL and model name.";
  }
  if (status === 429) return "Rate limited by the provider. Try again shortly.";
  if (status >= 500) return `The provider is unavailable (${status}).`;
  const detail = String(text || "").slice(0, 300);
  return detail
    ? `The provider refused the request (${status}): ${detail}`
    : `The provider refused the request (${status}).`;
}

/**
 * Stream a completion.
 *
 * @param {object} opts
 * @param {object} opts.config    `{ provider, baseUrl, model }`
 * @param {string} opts.apiKey
 * @param {string} opts.system
 * @param {Array}  opts.messages
 * @param {object|null} [opts.schema] the shape the answer must take. Defaults
 *   to the provider's netlist schema; `null` asks for prose (Feature 320's
 *   review, which is read by a person rather than by a compiler).
 * @param {(delta:{text?:string}) => void} opts.onDelta
 * @returns {{requestId:string,
 *            done:Promise<{ok:boolean, text?:string, error?:string,
 *                          usage?:{input?:number, output?:number,
 *                                  cacheWrite?:number, cacheRead?:number}}>}}
 */
function start({ config, apiKey, system, messages, schema, onDelta }) {
  const provider = providerFor(config?.provider);
  const requestId = `ai${++seq}`;
  if (!provider) {
    return {
      requestId,
      done: Promise.resolve({
        ok: false,
        error: `Unknown AI provider "${config?.provider}".`,
      }),
    };
  }
  if (provider.id === "anthropic" && !apiKey) {
    return {
      requestId,
      done: Promise.resolve({
        ok: false,
        error: "No API key is configured. Add one in Settings ▸ AI.",
      }),
    };
  }

  const controller = new AbortController();
  inflight.set(requestId, controller);

  // Declared out here so the wrapper below can close over it. Whatever the
  // request ends up doing — answering, refusing, erroring, being cancelled —
  // the tokens it burned getting there are worth reporting.
  let usage = null;

  const done = (async () => {
    let text = "";
    let refusal = null;
    try {
      const { url, headers, body } = provider.buildRequest({
        apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        system,
        messages,
        // Passed through only when the caller said something: `undefined` has
        // to reach the adapter's default parameter, and an explicit `null` has
        // to reach it as null. Spelling it as `schema: schema ?? DEFAULT` here
        // would put the netlist schema back on a prose request.
        ...(schema === undefined ? {} : { schema }),
      });
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return { ok: false, error: describeStatus(res.status, detail) };
      }
      if (!res.body) return { ok: false, error: "The provider sent no data." };

      let failure = null;
      await readSSE(res.body, (json, isSentinel) => {
        const ev = isSentinel ? json : provider.readEvent(json);
        if (ev.error) failure = ev.error;
        if (ev.refusal) refusal = ev.refusal;
        // Last-wins per field, never additive: the counts a provider streams
        // are cumulative, so summing `message_start`'s seed output with
        // `message_delta`'s final total would over-report by a few tokens.
        if (ev.usage) usage = { ...usage, ...ev.usage };
        if (ev.text) {
          text += ev.text;
          onDelta?.({ text: ev.text });
        }
      });
      if (failure) return { ok: false, error: failure };
      // A refusal is a successful HTTP call that produced no usable answer;
      // reporting it as text would hand the compiler an empty spec.
      if (refusal) return { ok: false, error: refusal, refusal: true };
      if (!text.trim()) {
        return { ok: false, error: "The model returned an empty response." };
      }
      return { ok: true, text };
    } catch (err) {
      if (err?.name === "AbortError") {
        return { ok: false, error: "Cancelled.", cancelled: true };
      }
      return {
        ok: false,
        error:
          `Could not reach the provider: ${err?.message ?? err}. ` +
          `Check the base URL and your connection.`,
      };
    } finally {
      inflight.delete(requestId);
    }
  })().then((result) => (usage ? { ...result, usage } : result));

  return { requestId, done };
}

/**
 * Test a connection: one tiny, unstreamed, unconstrained request.
 *
 * Settings ▸ AI's "Test connection" is asking a narrow question — can this
 * base URL, key and model be reached — so it must not fail for any other
 * reason. That is why it goes through `buildPing` rather than a one-token
 * `start()`: a real request carries the netlist schema, and a model declining
 * to fill one would read to the user as a broken key.
 *
 * @returns {Promise<{ok:true} | {ok:false, error:string}>}
 */
async function test({ config, apiKey }) {
  const provider = providerFor(config?.provider);
  if (!provider) {
    return { ok: false, error: `Unknown AI provider "${config?.provider}".` };
  }
  if (provider.id === "anthropic" && !apiKey) {
    return { ok: false, error: "No API key is configured." };
  }
  try {
    const { url, headers, body } = provider.buildPing({
      apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
    });
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, error: describeStatus(res.status, detail) };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        `Could not reach the provider: ${err?.message ?? err}. ` +
        `Check the base URL and your connection.`,
    };
  }
}

/** Abort an in-flight request. Returns false when it had already finished. */
function cancel(requestId) {
  const controller = inflight.get(requestId);
  if (!controller) return false;
  controller.abort();
  inflight.delete(requestId);
  return true;
}

/** Abort everything — used when the window goes away. */
function cancelAll() {
  for (const controller of inflight.values()) controller.abort();
  inflight.clear();
}

module.exports = { start, test, cancel, cancelAll, readSSE, describeStatus };
