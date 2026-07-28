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

// jsdom tests for the AI builder panel. The bridge is stubbed, so a whole
// generation — prompt, stream, verdict, repair round — runs offline.
//
// The two behaviours worth guarding are both about NOT trusting the model: a
// build that fails is never handed to the desk, and a failure that is OUR fault
// is not sent back for repair (the model cannot fix the compiler).

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { AiPanel } = await import("../components/ai-panel.js");

const COUNTER_SPEC = {
  title: "4-bit counter on an LED bar",
  parts: [
    { id: "CTR", ref: "74LS161" },
    { id: "BAR", ref: "bar8" },
    { id: "CLK", ref: "clock" },
  ],
  nets: [
    {
      name: "RUN",
      members: ["CTR.CLR", "CTR.LOAD", "CTR.ENP", "CTR.ENT", "VCC"],
    },
    { name: "CLOCK", members: ["CLK.out", "CTR.CLK"] },
    { name: "CLKGND", members: ["CLK.gnd", "GND"] },
    { name: "Q0", members: ["CTR.QA", "BAR.1"] },
    { name: "Q1", members: ["CTR.QB", "BAR.2"] },
    { name: "Q2", members: ["CTR.QC", "BAR.3"] },
    { name: "Q3", members: ["CTR.QD", "BAR.4"] },
    { name: "BARGND", members: ["BAR.K", "GND"] },
  ],
  tests: [{ name: "reset state", edges: 0, expect: { BAR: "00000000" } }],
};

/** Install a bridge that answers each `ai.start` with the next scripted reply. */
function stubBridge(replies) {
  const sent = [];
  let seq = 0;
  window.chiphippo = {
    ai: {
      start: async (config, system, messages) => {
        const requestId = `r${++seq}`;
        // Snapshot: the panel keeps appending to the same history array, so a
        // stored reference would show later turns as if they had been sent.
        sent.push({ requestId, config, system, messages: [...messages] });
        const reply = replies[seq - 1];
        // The real bridge answers first and pushes the result afterwards.
        queueMicrotask(() => {
          window.dispatchEvent(
            new window.CustomEvent("chiphippo:ai-done", {
              detail: { requestId, ok: true, text: reply },
            }),
          );
        });
        return { ok: true, requestId };
      },
      cancel: async () => ({ ok: true }),
    },
  };
  return sent;
}

/** Build a panel over a fresh container. */
function mount(opts = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const designs = [];
  const panel = new AiPanel(container, {
    config: () => ({ provider: "anthropic", baseUrl: "", model: "" }),
    onDesign: (clip) => designs.push(clip),
    ...opts,
  });
  panel.setVisible(true);
  return { panel, container, designs };
}

const ask = (container, text) => {
  const input = container.querySelector(".ai-input");
  input.value = text;
  container
    .querySelector(".ai-send")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
};

/** Drain microtasks + the panel's one deliberate `setTimeout` yield. */
const settleUi = () => new Promise((r) => setTimeout(r, 5));

/** Every line of a row kind — its text AND the fault list under it. */
const rows = (container, kind) =>
  [
    ...container.querySelectorAll(
      `.ai-row--${kind} .ai-row-text, .ai-row--${kind} .ai-row-list li`,
    ),
  ].map((p) => p.textContent);

test("AiPanel: mounts hidden and docks into its container", () => {
  resetDom();
  stubBridge([]);
  const container = document.createElement("div");
  document.body.append(container);
  const panel = new AiPanel(container, { config: () => ({}) });
  assert.ok(container.querySelector(".ai-panel"), "the panel mounted");
  assert.equal(panel.visible, false, "hidden until asked for");
  panel.setVisible(true);
  assert.equal(panel.visible, true);
});

test("AiPanel: a passing design is ARMED, never dropped", async () => {
  resetDom();
  const sent = stubBridge([JSON.stringify(COUNTER_SPEC)]);
  const { container, designs } = mount();

  ask(container, "a 4-bit counter on an LED bar");
  await settleUi();

  assert.equal(sent.length, 1, "one request went out");
  assert.ok(
    sent[0].system.includes("74LS161"),
    "the DERIVED catalog rode along in the system prompt",
  );
  assert.deepEqual(sent[0].messages, [
    { role: "user", content: "a 4-bit counter on an LED bar" },
  ]);

  assert.equal(designs.length, 1, "exactly one design was offered");
  assert.ok(designs[0].boards.length, "and it is a real clip");
  assert.match(rows(container, "ok").join(" "), /4-bit counter/);
  assert.match(rows(container, "note").join(" "), /Click to place it/);
});

test("AiPanel: a failing design is sent back for repair, and the fix lands", async () => {
  resetDom();
  const broken = {
    ...COUNTER_SPEC,
    tests: [{ name: "backwards", edges: 1, expect: { BAR: "00000001" } }],
  };
  const sent = stubBridge([
    JSON.stringify(broken),
    JSON.stringify(COUNTER_SPEC),
  ]);
  const { container, designs } = mount();

  ask(container, "a counter");
  await settleUi();
  await settleUi();

  assert.equal(sent.length, 2, "the failure went back once");
  const repair = sent[1].messages.at(-1);
  assert.equal(repair.role, "user");
  assert.match(repair.content, /TEST_FAILED/, "structured faults, not prose");
  assert.equal(
    sent[1].messages.at(-2).role,
    "assistant",
    "the model's own answer is in the conversation it is repairing",
  );
  assert.equal(designs.length, 1, "only the PASSING build was offered");
});

test("AiPanel: it gives up after two repair rounds rather than looping", async () => {
  resetDom();
  const broken = JSON.stringify({
    ...COUNTER_SPEC,
    tests: [{ name: "backwards", edges: 1, expect: { BAR: "00000001" } }],
  });
  const sent = stubBridge([broken, broken, broken, broken]);
  const { container, designs } = mount();

  ask(container, "a counter");
  for (let i = 0; i < 6; i++) await settleUi();

  assert.equal(sent.length, 3, "the first ask plus two repairs, and no more");
  assert.equal(designs.length, 0, "nothing was ever offered");
  assert.match(rows(container, "fail").join(" "), /Gave up after 2/);
});

test("AiPanel: a reply that will not parse is reported, not placed", async () => {
  resetDom();
  const prose = "I'm afraid I can't do that.";
  stubBridge([prose, prose, prose]);
  const { container, designs } = mount();

  ask(container, "something impossible");
  for (let i = 0; i < 6; i++) await settleUi();

  assert.equal(designs.length, 0, "nothing reached the desk");
  assert.match(rows(container, "fail").join(" "), /NOT_JSON/);
});

test("AiPanel: it refuses to build while the simulation is running", async () => {
  resetDom();
  const sent = stubBridge([JSON.stringify(COUNTER_SPEC)]);
  const { container, designs } = mount({ isLocked: () => true });

  ask(container, "a counter");
  await settleUi();

  assert.equal(sent.length, 0, "nothing was sent");
  assert.equal(designs.length, 0);
  assert.match(rows(container, "fail").join(" "), /Stop the simulation/);
});

test("AiPanel: Enter sends, Shift+Enter does not", async () => {
  resetDom();
  const sent = stubBridge([JSON.stringify(COUNTER_SPEC), "{}"]);
  const { container } = mount();
  const input = container.querySelector(".ai-input");

  input.value = "a counter";
  input.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
    }),
  );
  assert.equal(sent.length, 0, "Shift+Enter is a newline");

  input.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  await settleUi();
  assert.equal(sent.length, 1);
});

test("AiPanel: a keystroke in the prompt never reaches the desk's shortcuts", () => {
  resetDom();
  stubBridge([]);
  const { container } = mount();
  const seen = [];
  window.addEventListener("keydown", (e) => seen.push(e.key));
  // "w" arms the wire tool, "r" rotates a part — typing a description must not.
  container
    .querySelector(".ai-input")
    .dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "w", bubbles: true }),
    );
  assert.deepEqual(seen, [], "the panel stops the event at its input");
});

test("AiPanel: Clear forgets the conversation, so the next ask starts fresh", async () => {
  resetDom();
  const sent = stubBridge([
    JSON.stringify(COUNTER_SPEC),
    JSON.stringify(COUNTER_SPEC),
  ]);
  const { container } = mount();

  ask(container, "first");
  await settleUi();
  [...container.querySelectorAll(".ai-btn")]
    .find((b) => b.textContent === "Clear")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  ask(container, "second");
  await settleUi();
  assert.deepEqual(
    sent[1].messages,
    [{ role: "user", content: "second" }],
    "the first exchange is gone",
  );
});

test("AiPanel: a stale request's events are ignored", async () => {
  // Cancelling and asking again must not let the abandoned stream write into
  // the new one — every push carries its request id for exactly this.
  resetDom();
  stubBridge([JSON.stringify(COUNTER_SPEC)]);
  const { designs } = mount();

  window.dispatchEvent(
    new window.CustomEvent("chiphippo:ai-done", {
      detail: {
        requestId: "ghost",
        ok: true,
        text: JSON.stringify(COUNTER_SPEC),
      },
    }),
  );
  await settleUi();
  assert.equal(designs.length, 0, "a reply nobody asked for is dropped");
});
