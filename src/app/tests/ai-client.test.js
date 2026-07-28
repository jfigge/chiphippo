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

// The AI client and its providers, with no network. `fetch` is swapped for a
// stub, so every path here — streaming, cancellation, refusals, a bad key —
// runs deterministically and offline.

const test = require("node:test");
const assert = require("node:assert/strict");

const { start, cancel, readSSE, describeStatus } = require("../ai/client");
const { providerFor, NETLIST_SCHEMA } = require("../ai/providers");

/** A ReadableStream-ish async iterable of Uint8Array chunks. */
function bodyOf(chunks) {
  return (async function* () {
    for (const c of chunks) yield new TextEncoder().encode(c);
  })();
}

/** Frame a list of JSON payloads as server-sent events. */
const sse = (...payloads) =>
  payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join("");

function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = original;
  });
}

const CONFIG = { provider: "anthropic", baseUrl: "", model: "" };

// ── Providers ───────────────────────────────────────────────────────────────

test("the Anthropic request carries the key, version and schema", () => {
  const p = providerFor("anthropic");
  const { url, headers, body } = p.buildRequest({
    apiKey: "sk-test",
    baseUrl: "",
    model: "",
    system: "SYS",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(headers["x-api-key"], "sk-test");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(
    body.model,
    "claude-opus-5",
    "a current model id, no date suffix",
  );
  assert.equal(body.stream, true);
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.equal(body.output_config.format.schema, NETLIST_SCHEMA);
  // Sampling parameters are rejected by current models — none should be sent.
  for (const k of ["temperature", "top_p", "top_k"]) {
    assert.equal(k in body, false, `${k} must not be sent`);
  }
});

test("the schema stays legal under the strictest provider", () => {
  // Both invariants are 400s at REQUEST time, not bad output: an open-ended
  // map ("additionalProperties: object is not supported") on Anthropic, and a
  // property missing from `required` under OpenAI's strict mode. Either reads
  // to the user as "the provider refused the request", with nothing pointing
  // back at this schema — so walk the whole tree rather than trusting the one
  // leaf that broke last time.
  const walk = (node, path) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") {
      assert.equal(
        node.additionalProperties,
        false,
        `${path}: additionalProperties must be false, got ${JSON.stringify(
          node.additionalProperties,
        )}`,
      );
      assert.deepEqual(
        [...(node.required ?? [])].sort(),
        Object.keys(node.properties ?? {}).sort(),
        `${path}: every property must be required (optional = anyOf null)`,
      );
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      walk(child, `${path}.${key}`);
    }
    if (node.items) walk(node.items, `${path}[]`);
    (node.anyOf ?? []).forEach((child, i) => walk(child, `${path}|${i}`));
  };
  walk(NETLIST_SCHEMA, "netlist");
});

test("a trailing slash on the base URL does not double up", () => {
  const p = providerFor("anthropic");
  const { url } = p.buildRequest({
    apiKey: "k",
    baseUrl: "https://proxy.example.com///",
    system: "s",
    messages: [],
  });
  assert.equal(url, "https://proxy.example.com/v1/messages");
});

test("the OpenAI-compatible adapter omits the bearer when there is no key", () => {
  const p = providerFor("openai-compat");
  const local = p.buildRequest({
    apiKey: "",
    baseUrl: "",
    system: "s",
    messages: [],
  });
  assert.equal(
    "authorization" in local.headers,
    false,
    "a local server needs none",
  );
  assert.equal(local.url, "http://localhost:11434/v1/chat/completions");

  const hosted = p.buildRequest({
    apiKey: "sk-1",
    baseUrl: "https://api.openai.com",
    system: "s",
    messages: [],
  });
  assert.equal(hosted.headers.authorization, "Bearer sk-1");
  // The system prompt leads the message list in this shape.
  assert.equal(hosted.body.messages[0].role, "system");
});

test("an unknown provider id resolves to nothing", () => {
  assert.equal(providerFor("nope"), null);
  assert.equal(providerFor(undefined), null);
});

// ── SSE reading ─────────────────────────────────────────────────────────────

test("events split across chunk boundaries are not lost", async () => {
  // The failure this guards: splitting each chunk on "\n\n" independently drops
  // any event straddling a boundary, which looks like text going missing under
  // load rather than like an error.
  const whole = sse(
    { type: "content_block_delta", delta: { type: "text_delta", text: "he" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "llo" } },
  );
  const cut = Math.floor(whole.length / 2);
  const seen = [];
  await readSSE(bodyOf([whole.slice(0, cut), whole.slice(cut)]), (json) => {
    const ev = providerFor("anthropic").readEvent(json);
    if (ev.text) seen.push(ev.text);
  });
  assert.equal(seen.join(""), "hello");
});

test("a [DONE] sentinel and non-JSON frames are tolerated", async () => {
  const seen = [];
  await readSSE(
    bodyOf([": keepalive\n\n", "data: not json\n\n", "data: [DONE]\n\n"]),
    (json, sentinel) => seen.push(sentinel ? "done" : json),
  );
  assert.deepEqual(seen, ["done"]);
});

// ── The client ──────────────────────────────────────────────────────────────

test("a streamed answer accumulates and reports deltas as they arrive", async () => {
  const deltas = [];
  await withFetch(
    async () => ({
      ok: true,
      body: bodyOf([
        sse(
          {
            type: "content_block_delta",
            delta: { type: "text_delta", text: '{"parts"' },
          },
          {
            type: "content_block_delta",
            delta: { type: "text_delta", text: ":[]}" },
          },
          { type: "message_stop" },
        ),
      ]),
    }),
    async () => {
      const { done } = start({
        config: CONFIG,
        apiKey: "k",
        system: "s",
        messages: [],
        onDelta: (d) => deltas.push(d.text),
      });
      const r = await done;
      assert.equal(r.ok, true);
      assert.equal(r.text, '{"parts":[]}');
      assert.deepEqual(deltas, ['{"parts"', ":[]}"]);
    },
  );
});

test("a refusal is a failure, not an empty answer", async () => {
  // Anthropic returns HTTP 200 on a policy decline. Treating that as success
  // would hand the compiler an empty spec and report a confusing parse error.
  await withFetch(
    async () => ({
      ok: true,
      body: bodyOf([
        sse({
          type: "message_delta",
          delta: {
            stop_reason: "refusal",
            stop_details: { explanation: "declined for policy reasons" },
          },
        }),
      ]),
    }),
    async () => {
      const { done } = start({
        config: CONFIG,
        apiKey: "k",
        system: "s",
        messages: [],
      });
      const r = await done;
      assert.equal(r.ok, false);
      assert.equal(r.refusal, true);
      assert.match(r.error, /declined for policy/);
    },
  );
});

test("an empty response is reported rather than passed on", async () => {
  await withFetch(
    async () => ({ ok: true, body: bodyOf([sse({ type: "message_stop" })]) }),
    async () => {
      const { done } = start({
        config: CONFIG,
        apiKey: "k",
        system: "s",
        messages: [],
      });
      const r = await done;
      assert.equal(r.ok, false);
      assert.match(r.error, /empty/i);
    },
  );
});

test("HTTP failures say something actionable", async () => {
  for (const [status, pattern] of [
    [401, /API key/i],
    [404, /base URL/i],
    [429, /Rate limited/i],
    [503, /unavailable/i],
  ]) {
    await withFetch(
      async () => ({ ok: false, status, text: async () => "" }),
      async () => {
        const { done } = start({
          config: CONFIG,
          apiKey: "k",
          system: "s",
          messages: [],
        });
        const r = await done;
        assert.equal(r.ok, false);
        assert.match(r.error, pattern, `status ${status}`);
      },
    );
  }
});

test("a network error names the thing the user can fix", async () => {
  await withFetch(
    async () => {
      throw new Error("ECONNREFUSED");
    },
    async () => {
      const { done } = start({
        config: CONFIG,
        apiKey: "k",
        system: "s",
        messages: [],
      });
      const r = await done;
      assert.equal(r.ok, false);
      assert.match(r.error, /base URL/);
    },
  );
});

test("an in-flight request can be cancelled", async () => {
  await withFetch(
    (_url, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      }),
    async () => {
      const { requestId, done } = start({
        config: CONFIG,
        apiKey: "k",
        system: "s",
        messages: [],
      });
      assert.equal(cancel(requestId), true);
      const r = await done;
      assert.equal(r.ok, false);
      assert.equal(r.cancelled, true);
      // Cancelling twice is a no-op, not an error.
      assert.equal(cancel(requestId), false);
    },
  );
});

test("a missing key fails before any request is made", async () => {
  let called = false;
  await withFetch(
    async () => {
      called = true;
      return { ok: true, body: bodyOf([]) };
    },
    async () => {
      const { done } = start({
        config: CONFIG,
        apiKey: "",
        system: "s",
        messages: [],
      });
      const r = await done;
      assert.equal(r.ok, false);
      assert.match(r.error, /Settings/);
      assert.equal(called, false, "nothing was sent");
    },
  );
});

test("describeStatus never leaks an unbounded provider body", () => {
  const long = "x".repeat(5000);
  assert.ok(describeStatus(400, long).length < 400);
});
