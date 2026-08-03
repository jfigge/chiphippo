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

// providers.js — the two request shapes, behind one interface (Feature 260).
//
// A provider knows how to turn "here is a system prompt and a conversation"
// into an HTTP request, and how to read one server-sent event back. Nothing
// else in the AI path branches on which provider is configured, so adding a
// third is a new entry in this file and nowhere else.
//
//   buildRequest({ apiKey, baseUrl, model, system, messages, maxTokens })
//     → { url, headers, body }
//   readEvent(json)  → { text?, done?, error?, refusal?, usage? }
//   buildPing({ apiKey, baseUrl, model })  → { url, headers, body }
//
// The OpenAI-compatible shape is deliberately not "OpenAI": the same wire
// format is what Ollama, LM Studio, OpenRouter and vLLM all speak, so one
// adapter plus a user-supplied base URL covers every local and hosted endpoint
// worth supporting. That is why the base URL is configuration rather than a
// constant.

/**
 * A `{ target: value }` map, expressed as a LIST of pairs.
 *
 * Structured outputs cannot express an open-ended map. `additionalProperties`
 * must be `false` on every object, so the natural spelling — "any key, string
 * value" — is rejected outright with `For 'object' type, 'additionalProperties:
 * object' is not supported`. A pair list says the same thing in a closed shape,
 * and `ai/generate.js` folds it back into the map the verifier reads, so the
 * spec shape everything downstream sees is unchanged.
 */
const PIN_MAP = Object.freeze({
  type: "array",
  items: {
    type: "object",
    properties: {
      target: { type: "string" },
      value: { type: "string" },
    },
    required: ["target", "value"],
    additionalProperties: false,
  },
});

/**
 * An optional field.
 *
 * The STRICTEST reading of structured outputs — OpenAI's `strict: true` — has
 * no notion of an omitted property: every key in `properties` must also be in
 * `required`. So "optional" is spelled as "required, but may be null", and
 * `ai/generate.js` drops the nulls again. Anthropic does not demand this, but a
 * schema that satisfies the stricter reader satisfies both, and one shared
 * schema is the whole point of this file.
 */
const optional = (schema) =>
  Object.freeze({ anyOf: [schema, { type: "null" }] });

/**
 * A JSON Schema the model must fill. Structured outputs make a malformed
 * netlist a non-event — the schema is enforced server-side — so the renderer's
 * own validation is about MEANING (does this circuit work?) rather than shape.
 *
 * Kept deliberately flat: no recursion, and no array-length constraints (those
 * are checked in the compiler, which can say *which* net is wrong). Two
 * invariants are load-bearing rather than stylistic, and `ai-client.test.js`
 * walks this whole object to hold both: `additionalProperties: false` on every
 * object, and `required` naming every property. Break either and the provider
 * rejects the REQUEST — which surfaces to the user as "the provider refused",
 * with nothing pointing back at this file.
 */
const NETLIST_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    title: optional({ type: "string" }),
    // One paragraph explaining the design, stamped on the desk as a caption
    // (autobuild.js). A generated circuit arrives with no history — the user
    // did not build it and cannot ask it why it is wired this way.
    notes: optional({ type: "string" }),
    parts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          ref: { type: "string" },
          label: optional({ type: "string" }),
        },
        required: ["id", "ref", "label"],
        additionalProperties: false,
      },
    },
    nets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          members: { type: "array", items: { type: "string" } },
        },
        required: ["name", "members"],
        additionalProperties: false,
      },
    },
    tests: optional({
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          set: optional(PIN_MAP),
          edges: optional({ type: "integer" }),
          expect: PIN_MAP,
        },
        required: ["name", "set", "edges", "expect"],
        additionalProperties: false,
      },
    }),
  },
  required: ["title", "notes", "parts", "nets", "tests"],
  additionalProperties: false,
});

const trimBase = (url, fallback) => String(url || fallback).replace(/\/+$/, "");

/**
 * Keep only the counts that are actually numbers.
 *
 * An absent field must be OMITTED rather than set to `undefined`: the client
 * merges usage across events with a spread, so `{ output: undefined }` would
 * clobber a count it already knew. Returns null when there is nothing to
 * report, which is what keeps a provider that sends no usage from showing a
 * row of zeroes.
 */
function usageOf(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

/** Anthropic's names. `input_tokens` EXCLUDES both cache buckets. */
const anthropicUsage = (u) =>
  u
    ? usageOf({
        input: u.input_tokens,
        output: u.output_tokens,
        cacheWrite: u.cache_creation_input_tokens,
        cacheRead: u.cache_read_input_tokens,
      })
    : null;

/**
 * OpenAI's names — and the one place the two providers disagree about meaning.
 *
 * `prompt_tokens` INCLUDES cached tokens; Anthropic's `input_tokens` excludes
 * them. Subtracting here is what makes `input` mean the same thing downstream,
 * rather than the same field silently counting the cache twice on one provider.
 */
const openaiUsage = (u) => {
  if (!u) return null;
  const cacheRead = u.prompt_tokens_details?.cached_tokens;
  const prompt = u.prompt_tokens;
  return usageOf({
    input: Number.isFinite(prompt)
      ? Math.max(0, prompt - (Number.isFinite(cacheRead) ? cacheRead : 0))
      : NaN,
    output: u.completion_tokens,
    cacheRead,
  });
};

const anthropic = Object.freeze({
  id: "anthropic",
  label: "Anthropic",
  defaultBaseUrl: "https://api.anthropic.com",
  defaultModel: "claude-opus-5",
  keyLabel: "API key",

  buildRequest({
    apiKey,
    baseUrl,
    model,
    system,
    messages,
    maxTokens = 16000,
    schema = NETLIST_SCHEMA,
  }) {
    return {
      url: `${trimBase(baseUrl, this.defaultBaseUrl)}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: model || this.defaultModel,
        max_tokens: maxTokens,
        stream: true,
        // Adaptive thinking with a high effort: this is a reasoning task
        // (which chips, wired how) rather than a transcription one. Both halves
        // of `output_config` are independent — the EFFORT applies whatever
        // shape the answer takes, so a prose reply (Feature 320's review) drops
        // only the format and thinks exactly as hard.
        thinking: { type: "adaptive" },
        output_config: {
          effort: "high",
          ...(schema ? { format: { type: "json_schema", schema } } : {}),
        },
        system: [
          { type: "text", text: system, cache_control: { type: "ephemeral" } },
        ],
        messages,
      },
    };
  },

  /**
   * The smallest request that still exercises everything a real one needs:
   * the base URL, the key, and the model id. Deliberately NOT streamed and
   * NOT schema-constrained — Test connection is asking "can I reach you", so
   * it should fail for connection reasons only, never because a model
   * declined to fill a netlist.
   */
  buildPing({ apiKey, baseUrl, model }) {
    return {
      url: `${trimBase(baseUrl, this.defaultBaseUrl)}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: model || this.defaultModel,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      },
    };
  },

  /**
   * Anthropic streams `content_block_delta` events carrying text. A policy
   * decline arrives as a normal 200 with `stop_reason: "refusal"` and empty or
   * partial content — so it is surfaced explicitly rather than left to look
   * like an empty answer.
   *
   * Usage arrives in TWO places and must be merged last-wins, not summed:
   * `message_start` carries the prompt counts plus a token initial output
   * count, and `message_delta` carries the CUMULATIVE final output count.
   */
  readEvent(json) {
    if (!json || typeof json !== "object") return {};
    if (json.type === "content_block_delta") {
      const d = json.delta ?? {};
      if (d.type === "text_delta" && typeof d.text === "string") {
        return { text: d.text };
      }
      return {};
    }
    if (json.type === "message_start") {
      const usage = anthropicUsage(json.message?.usage);
      return usage ? { usage } : {};
    }
    if (json.type === "message_delta") {
      // Note the usage is a SIBLING of `delta`, not inside it — reading
      // `json.delta.usage` finds nothing and silently reports no output.
      const usage = anthropicUsage(json.usage);
      const out = usage ? { usage } : {};
      if (json.delta?.stop_reason === "refusal") {
        out.refusal =
          json.delta?.stop_details?.explanation ??
          "The model declined this request.";
      }
      return out;
    }
    if (json.type === "message_stop") return { done: true };
    if (json.type === "error") {
      return {
        error: json.error?.message ?? "The provider reported an error.",
      };
    }
    return {};
  },
});

const openaiCompat = Object.freeze({
  id: "openai-compat",
  label: "OpenAI-compatible",
  defaultBaseUrl: "http://localhost:11434",
  defaultModel: "llama3.1",
  keyLabel: "API key (blank for a local server)",

  buildRequest({
    apiKey,
    baseUrl,
    model,
    system,
    messages,
    maxTokens = 16000,
    schema = NETLIST_SCHEMA,
  }) {
    const headers = { "content-type": "application/json" };
    // A local Ollama/LM Studio needs no key; a hosted endpoint does. Sending
    // an empty bearer breaks the local case, so only send one when there is
    // something to send.
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    return {
      url: `${trimBase(baseUrl, this.defaultBaseUrl)}/v1/chat/completions`,
      headers,
      body: {
        model: model || this.defaultModel,
        max_tokens: maxTokens,
        stream: true,
        // Ask for the trailing usage chunk. A server strict enough to reject an
        // unknown field is already rejecting `response_format` below, which is
        // the narrower compatibility bet of the two — so this costs nothing
        // that was working. Drop this one line if a local server complains.
        stream_options: { include_usage: true },
        // No schema means a prose answer, and the field goes rather than being
        // set to some "any" shape — a local server that does not implement
        // `response_format` at all then sees a request it can serve.
        ...(schema
          ? {
              response_format: {
                type: "json_schema",
                json_schema: { name: "netlist", schema, strict: true },
              },
            }
          : {}),
        messages: [{ role: "system", content: system }, ...messages],
      },
    };
  },

  /** See the Anthropic adapter's note — reachability only. */
  buildPing({ apiKey, baseUrl, model }) {
    const headers = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    return {
      url: `${trimBase(baseUrl, this.defaultBaseUrl)}/v1/chat/completions`,
      headers,
      body: {
        model: model || this.defaultModel,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      },
    };
  },

  readEvent(json) {
    if (!json || typeof json !== "object") return {};
    if (json.error) {
      return { error: json.error.message ?? "The provider reported an error." };
    }
    // The usage chunk carries an EMPTY `choices` array, so this has to be read
    // before the guard below rather than after it. Read it whenever it is
    // offered, so a server that volunteers usage without being asked still
    // reports.
    const usage = openaiUsage(json.usage);
    const out = usage ? { usage } : {};
    const choice = json.choices?.[0];
    if (!choice) return out;
    const text = choice.delta?.content;
    if (typeof text === "string" && text) out.text = text;
    else if (choice.finish_reason) out.done = true;
    return out;
  },
});

const PROVIDERS = Object.freeze({
  anthropic,
  "openai-compat": openaiCompat,
});

/** The adapter for an id, or null. */
function providerFor(id) {
  return PROVIDERS[id] ?? null;
}

module.exports = { PROVIDERS, providerFor, NETLIST_SCHEMA };
