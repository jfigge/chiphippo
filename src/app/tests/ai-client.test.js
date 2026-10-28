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

// The AI client and its providers, with no network. `fetch` is swapped for a
// stub, so every path here — streaming, cancellation, refusals, a bad key —
// runs deterministically and offline.

const test = require("node:test");
const assert = require("node:assert/strict");

const { start, cancel, readSSE, describeStatus } = require("../ai/client");
const { providerFor, NETLIST_SCHEMA, TRUNCATED } = require("../ai/providers");

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

test("a prose answer drops the schema and keeps the effort", () => {
  // Feature 320's desk review is read by a person, not by a compiler, so it
  // asks for no shape. What it must NOT drop is the reasoning: `effort` and
  // `thinking` are independent of the format, and a review that thought less
  // hard than a build would be the wrong trade entirely.
  const { body } = providerFor("anthropic").buildRequest({
    apiKey: "sk-test",
    baseUrl: "",
    model: "",
    system: "SYS",
    messages: [{ role: "user", content: "what is wrong?" }],
    schema: null,
  });
  assert.equal("format" in body.output_config, false, "no schema is imposed");
  assert.equal(body.output_config.effort, "high");
  assert.deepEqual(body.thinking, { type: "adaptive" });

  const compat = providerFor("openai-compat").buildRequest({
    apiKey: "",
    baseUrl: "",
    system: "SYS",
    messages: [],
    schema: null,
  }).body;
  // The FIELD goes, rather than being set to some permissive shape — a local
  // server that does not implement `response_format` then sees a request it
  // can serve.
  assert.equal("response_format" in compat, false);
  assert.deepEqual(compat.stream_options, { include_usage: true });
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

test("plain http to another machine is refused — the key would travel in clear", async () => {
  for (const id of ["anthropic", "openai-compat"]) {
    for (const baseUrl of [
      "http://api.anthropic.com",
      "http://192.168.1.20:11434",
      "http://localhost.example.com",
    ]) {
      assert.throws(
        () =>
          providerFor(id).buildRequest({
            apiKey: "k",
            baseUrl,
            system: "s",
            messages: [],
          }),
        /must be an https address/,
        `${id} ${baseUrl}`,
      );
      assert.throws(
        () => providerFor(id).buildPing({ apiKey: "k", baseUrl, model: "m" }),
        /must be an https address/,
      );
    }
  }
  // This machine stays reachable over http (a local Ollama / LM Studio), and
  // https goes anywhere (a proxy, OpenRouter).
  for (const baseUrl of ["http://127.0.0.1:1234", "http://[::1]:11434"]) {
    const { url } = providerFor("openai-compat").buildRequest({
      apiKey: "k",
      baseUrl,
      system: "s",
      messages: [],
    });
    assert.equal(url, `${baseUrl}/v1/chat/completions`);
  }
  // And the client — what main's ai:start runs — never reaches fetch.
  let called = false;
  await withFetch(
    async () => {
      called = true;
      return { ok: true };
    },
    async () => {
      const { done } = start({
        config: { ...CONFIG, baseUrl: "http://proxy.example.com" },
        apiKey: "k",
        system: "s",
        messages: [],
      });
      const r = await done;
      assert.equal(r.ok, false);
      assert.match(r.error, /https/);
    },
  );
  assert.equal(called, false);
});

test("a base URL that is not http(s) is refused before any request", async () => {
  for (const id of ["anthropic", "openai-compat"]) {
    assert.throws(
      () =>
        providerFor(id).buildRequest({
          apiKey: "k",
          baseUrl: "file:///etc",
          system: "s",
          messages: [],
        }),
      /http\(s\)/,
    );
  }
  // Plain http stays allowed — a local Ollama / LM Studio.
  const { url } = providerFor("openai-compat").buildRequest({
    apiKey: "",
    baseUrl: "http://localhost:11434",
    system: "s",
    messages: [],
  });
  assert.equal(url, "http://localhost:11434/v1/chat/completions");
  let called = false;
  await withFetch(
    async () => {
      called = true;
      return { ok: true };
    },
    async () => {
      const { done } = start({
        config: { ...CONFIG, baseUrl: "javascript:alert(1)" },
        apiKey: "k",
        system: "s",
        messages: [],
      });
      const r = await done;
      assert.equal(r.ok, false);
    },
  );
  assert.equal(called, false, "nothing was sent");
});

test("the key never follows a redirect, and a refused one is named", async () => {
  let seen = null;
  let result = null;
  await withFetch(
    async (_url, init) => {
      seen = init.redirect;
      throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") }); // prettier-ignore
    },
    async () => {
      const { done } = start({ config: CONFIG, apiKey: "k", system: "s", messages: [] }); // prettier-ignore
      result = await done;
    },
  );
  assert.equal(seen, "error");
  assert.match(result.error, /redirects somewhere else/);
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

// ── Usage ───────────────────────────────────────────────────────────────────

test("Anthropic usage is read from both places it arrives", () => {
  const p = providerFor("anthropic");
  assert.deepEqual(
    p.readEvent({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 20,
          output_tokens: 1,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 3700,
        },
      },
    }).usage,
    { input: 20, output: 1, cacheRead: 1000, cacheWrite: 3700 },
  );
  // Usage is a SIBLING of `delta` on this event, not inside it.
  assert.deepEqual(
    p.readEvent({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 250 },
    }).usage,
    { output: 250 },
  );
  // The shape that reads plausibly and finds nothing — pinned so a "tidy-up"
  // that moves the read under `delta` fails here rather than in production.
  assert.equal(
    "usage" in
      p.readEvent({ type: "message_delta", delta: { usage: { a: 1 } } }),
    false,
  );
});

test("the OpenAI-compatible adapter reads the trailing usage chunk", () => {
  // That chunk carries `choices: []`, so it is dropped by any reader that
  // looks at choices[0] first. `prompt_tokens` INCLUDES the cached tokens
  // here, unlike Anthropic's `input_tokens` — hence 1200 - 1000 = 200.
  const p = providerFor("openai-compat");
  assert.deepEqual(
    p.readEvent({
      choices: [],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 80,
        prompt_tokens_details: { cached_tokens: 1000 },
      },
    }).usage,
    { input: 200, output: 80, cacheRead: 1000 },
  );
});

test("the OpenAI-compatible request asks for usage", () => {
  const { body } = providerFor("openai-compat").buildRequest({
    apiKey: "",
    baseUrl: "",
    system: "s",
    messages: [],
  });
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test("output tokens are last-wins, not summed", async () => {
  // The whole reason the merge is a spread rather than an addition: 251 here
  // instead of 250 means someone made it additive and every report is now a
  // few tokens high.
  await withFetch(
    async () => ({
      ok: true,
      body: bodyOf([
        sse(
          {
            type: "message_start",
            message: {
              usage: {
                input_tokens: 20,
                output_tokens: 1,
                cache_read_input_tokens: 1000,
              },
            },
          },
          {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "{}" },
          },
          { type: "message_delta", delta: {}, usage: { output_tokens: 250 } },
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
      });
      const r = await done;
      assert.equal(r.ok, true);
      assert.deepEqual(r.usage, { input: 20, output: 250, cacheRead: 1000 });
    },
  );
});

test("a refusal still reports what it spent", async () => {
  // A refusal is billed for whatever streamed, and its usage rides the very
  // event that reports the refusal — so the failure paths must carry it too.
  await withFetch(
    async () => ({
      ok: true,
      body: bodyOf([
        sse({
          type: "message_delta",
          delta: { stop_reason: "refusal" },
          usage: { output_tokens: 12 },
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
      assert.deepEqual(r.usage, { output: 12 });
    },
  );
});

test("a reply cut off at the output limit is its own failure, not half a JSON", async () => {
  // Read as a success it reached the compiler as NOT_JSON and bought up to
  // two more billed repair rounds asking for the same too-long answer.
  const anthropic = sse(
    {
      type: "content_block_delta",
      delta: { type: "text_delta", text: '{"parts":[' },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "max_tokens" },
      usage: { output_tokens: 16000 },
    },
    { type: "message_stop" },
  );
  const openai = sse(
    { choices: [{ delta: { content: '{"parts":[' } }] },
    { choices: [{ delta: {}, finish_reason: "length" }] },
  );
  for (const [provider, body] of [
    ["anthropic", anthropic],
    ["openai-compat", openai],
  ]) {
    await withFetch(
      async () => ({ ok: true, body: bodyOf([body]) }),
      async () => {
        const { done } = start({
          config: { ...CONFIG, provider },
          apiKey: "k",
          system: "s",
          messages: [],
        });
        const r = await done;
        assert.equal(r.ok, false, provider);
        assert.equal(r.error, TRUNCATED, provider);
        assert.equal(r.refusal, undefined, "not a refusal");
      },
    );
  }
  // A last chunk carrying text AND the finish reason is still truncation.
  const ev = providerFor("openai-compat").readEvent({
    choices: [{ delta: { content: "x" }, finish_reason: "length" }],
  });
  assert.equal(ev.text, "x");
  assert.equal(ev.error, TRUNCATED);
  // …and an ordinary stop is not.
  const stop = providerFor("openai-compat").readEvent({
    choices: [{ delta: {}, finish_reason: "stop" }],
  });
  assert.deepEqual(stop, { done: true });
});

test("a stream with no usage reports none rather than zeroes", async () => {
  await withFetch(
    async () => ({
      ok: true,
      body: bodyOf([
        sse(
          {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "{}" },
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
      });
      const r = await done;
      assert.equal(r.ok, true);
      assert.equal("usage" in r, false, "absent, not a row of zeroes");
    },
  );
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

test("a body with only a reader (Safari's ReadableStream) is read too", async () => {
  // Safari's ReadableStream has no async iterator; the web build runs this
  // file in the tab, so readSSE must fall back to getReader().
  const chunks = [sse({ n: 1 }), sse({ n: 2 })].map((c) =>
    new TextEncoder().encode(c),
  );
  let released = false;
  const body = {
    getReader: () => ({
      read: async () =>
        chunks.length
          ? { done: false, value: chunks.shift() }
          : { done: true, value: undefined },
      releaseLock: () => (released = true),
    }),
  };
  const seen = [];
  await readSSE(body, (json) => seen.push(json.n));
  assert.deepEqual(seen, [1, 2]);
  assert.equal(released, true, "the reader is let go");
});

test("a reader-only body left early is cancelled before it is let go", async () => {
  // The iterator path cancels the stream on return(); the reader path must
  // too, or a consumer that throws leaves the response downloading.
  const order = [];
  const body = {
    getReader: () => ({
      read: async () => ({
        done: false,
        value: new TextEncoder().encode("data: [DONE]\n\n"),
      }),
      cancel: async () => order.push("cancel"),
      releaseLock: () => order.push("release"),
    }),
  };
  await assert.rejects(
    readSSE(body, () => {
      throw new Error("consumer gave up");
    }),
    /consumer gave up/,
  );
  assert.deepEqual(order, ["cancel", "release"]);
});

test("a [DONE] sentinel and non-JSON frames are tolerated", async () => {
  const seen = [];
  await readSSE(
    bodyOf([": keepalive\n\n", "data: not json\n\n", "data: [DONE]\n\n"]),
    (json, sentinel) => seen.push(sentinel ? "done" : json),
  );
  assert.deepEqual(seen, ["done"]);
});

test("CRLF-framed streams are read — a CR/LF pair split across chunks too", async () => {
  // sse-starlette (llama-cpp-python's server) ends lines in CRLF; "\r\n\r\n"
  // has no "\n\n" in it, so this stream used to yield nothing at all.
  const crlf = 'data: {"n":1}\r\n\r\ndata: {"n":2}\r\n\r\ndata: [DONE]\r\n\r\n';
  for (const cut of [1, 13, 14, 15, 16, crlf.length - 2]) {
    const seen = [];
    await readSSE(bodyOf([crlf.slice(0, cut), crlf.slice(cut)]), (json, done) =>
      seen.push(done ? "done" : json.n),
    );
    assert.deepEqual(seen, [1, 2, "done"], `cut at ${cut}`);
  }
});

test("bare-CR line endings, and a last frame with no blank line after it", async () => {
  const seen = [];
  await readSSE(bodyOf(['data: {"n":1}\r\rdata: {"n":2}']), (json) =>
    seen.push(json.n),
  );
  assert.deepEqual(seen, [1, 2]);
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

test("readSSE: any chunking reads the same events, in time linear in the body", async () => {
  const events = Array.from({ length: 200 }, (_, i) => `data: {"n":${i}}`);
  for (const eol of ["\n", "\r\n", "\r"]) {
    const bytes = new TextEncoder().encode(
      events.map((e) => `${e}${eol}${eol}`).join(""),
    );
    let x = 7;
    for (let round = 0; round < 20; round++) {
      const chunks = [];
      for (let i = 0; i < bytes.length;) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        const n = 1 + (x % 23);
        chunks.push(bytes.subarray(i, i + n));
        i += n;
      }
      const got = [];
      await readSSE(
        (async function* () {
          yield* chunks;
        })(),
        (e) => got.push(e.n),
      );
      assert.deepEqual(got, [...events.keys()], JSON.stringify(eol));
    }
  }
  // 16 MB with no blank line: once quadratic (seconds), now a few ms.
  const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
  const t0 = performance.now();
  await readSSE(
    (async function* () {
      for (let i = 0; i < 1024; i++) yield chunk;
    })(),
    () => {},
  );
  assert.ok(performance.now() - t0 < 1000, "linear");
});
