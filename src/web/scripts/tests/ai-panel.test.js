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

/**
 * Install a bridge that answers each `ai.start` with the next scripted reply.
 *
 * A reply is either a bare string (a successful answer, no usage reported — the
 * shape every provider-less test uses) or a `{text, usage, ok, error}` object
 * for the cases that care what a round cost or how it failed.
 */
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
        const detail =
          typeof reply === "string"
            ? { ok: true, text: reply }
            : { ok: true, ...reply };
        // The real bridge answers first and pushes the result afterwards.
        queueMicrotask(() => {
          window.dispatchEvent(
            new window.CustomEvent("chiphippo:ai-done", {
              detail: { requestId, ...detail },
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

/** The header's session total, or "" while it is hidden. */
const total = (container) => {
  const span = container.querySelector(".ai-usage");
  return span.hidden ? "" : span.textContent;
};

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

/**
 * Let one round finish.
 *
 * The build is no longer a single deferred call. `AiPanel` steps the verify
 * ladder gate by gate and yields to the event loop between each so the label
 * can paint, so a round spans one task per gate plus one per acceptance test —
 * and a test awaiting a single timer would sample the panel mid-ladder.
 * Draining a generous number of tasks keeps every call site meaning exactly
 * what it always meant: "let the round complete".
 */
const settleUi = async (tasks = 24) => {
  for (let i = 0; i < tasks; i++) await new Promise((r) => setTimeout(r, 0));
};

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

// ── Tokens ──────────────────────────────────────────────────────────────────

const USAGE = { input: 1203, output: 2412, cacheRead: 11776 };

test("AiPanel: a completed build reports what it cost", async () => {
  resetDom();
  stubBridge([{ text: JSON.stringify(COUNTER_SPEC), usage: USAGE }]);
  const { container } = mount();

  ask(container, "a counter");
  await settleUi();

  const notes = rows(container, "note").join(" ");
  assert.match(notes, /Tokens: 1,203 in · 11,776 cache read · 2,412 out/);
  assert.equal(total(container), "Session: 12,979 in · 2,412 out");
});

test("AiPanel: a repair round's tokens are added once, not per round", async () => {
  // Two API calls, one ask. The failure this guards is reporting each round
  // separately, which leaves the user adding up lines to learn what a design
  // actually cost.
  resetDom();
  const broken = {
    ...COUNTER_SPEC,
    tests: [{ name: "backwards", edges: 1, expect: { BAR: "00000001" } }],
  };
  stubBridge([
    { text: JSON.stringify(broken), usage: { input: 100, output: 200 } },
    { text: JSON.stringify(COUNTER_SPEC), usage: { input: 50, output: 400 } },
  ]);
  const { container } = mount();

  ask(container, "a counter");
  await settleUi();
  await settleUi();

  const lines = rows(container, "note").filter((t) => t.startsWith("Tokens:"));
  assert.equal(lines.length, 1, "one line per ask, not one per round");
  assert.equal(lines[0], "Tokens: 150 in · 600 out · 2 calls");
});

test("AiPanel: a failed generation still reports what it spent", async () => {
  // The case that matters most — a give-up is the most expensive outcome, so
  // hiding its cost would understate spend exactly where it is highest.
  resetDom();
  stubBridge([{ ok: false, error: "Overloaded.", usage: { input: 900 } }]);
  const { container } = mount();

  ask(container, "a counter");
  await settleUi();

  assert.match(rows(container, "fail").join(" "), /Overloaded/);
  assert.match(rows(container, "note").join(" "), /Tokens: 900 in/);
});

test("AiPanel: the session total accumulates, and Clear resets it", async () => {
  resetDom();
  stubBridge([
    { text: JSON.stringify(COUNTER_SPEC), usage: { input: 100, output: 200 } },
    { text: JSON.stringify(COUNTER_SPEC), usage: { input: 30, output: 70 } },
  ]);
  const { container } = mount();

  ask(container, "first");
  await settleUi();
  assert.equal(total(container), "Session: 100 in · 200 out");

  ask(container, "second");
  await settleUi();
  assert.equal(total(container), "Session: 130 in · 270 out");
  assert.match(
    container.querySelector(".ai-usage").title,
    /across 2 sends/,
    "the tooltip keeps the split the line drops",
  );

  [...container.querySelectorAll(".ai-btn")]
    .find((b) => b.textContent === "Clear")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(total(container), "", "Clear resets the total it owns");
});

test("AiPanel: a provider that reports no usage shows no tokens at all", async () => {
  // Every other test in this file drives the bare-string reply shape, so this
  // also pins that adding usage did not change what happens without it.
  resetDom();
  stubBridge([JSON.stringify(COUNTER_SPEC)]);
  const { container } = mount();

  ask(container, "a counter");
  await settleUi();

  assert.equal(
    rows(container, "note").some((t) => t.startsWith("Tokens:")),
    false,
    "no line rather than a row of zeroes",
  );
  assert.equal(total(container), "");
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

/**
 * Every label the working row ever showed.
 *
 * Sampling on a timer misses the ones that live for less than a task — the
 * streaming row is created and replaced inside a single synchronous stretch —
 * so this observes the log instead, which catches each label at the microtask
 * checkpoint after the write that set it.
 */
function watchWorking(container) {
  const seen = new Set();
  const sample = () => {
    const row = container.querySelector(".ai-row--working .ai-row-text");
    if (row?.textContent) seen.add(row.textContent);
  };
  const observer = new window.MutationObserver(sample);
  observer.observe(container.querySelector(".ai-log"), {
    childList: true,
    characterData: true,
    subtree: true,
  });
  sample();
  return {
    seen,
    stop: () => {
      observer.disconnect();
      return [...seen].join(" | ");
    },
  };
}

// ── Progress, and the guard that comes with it ──────────────────────────────

test("AiPanel: the build reports each gate as it runs", async () => {
  resetDom();
  stubBridge([JSON.stringify(COUNTER_SPEC)]);
  const { container } = mount();

  const watch = watchWorking(container);
  ask(container, "a counter");
  await settleUi();
  const labels = watch.stop();
  assert.match(labels, /Designing the circuit/, "the streaming phase");
  assert.match(labels, /Compiling/, "then compiling");
  assert.match(labels, /Simulating/, "and the gate that actually takes time");
  assert.match(labels, /Running test 1 of/, "with L7 counted off per test");
  assert.equal(
    container.querySelector(".ai-row--working"),
    null,
    "and the row is gone once the build lands",
  );
});

test("AiPanel: a second send during the build cannot start a paid request", async () => {
  // The whole reason the build tracks itself. It spans many tasks now, so
  // there is a real window with no request in flight — and a send landing in
  // it used to be stopped only by the prompt happening to be empty.
  resetDom();
  const sent = stubBridge([
    JSON.stringify(COUNTER_SPEC),
    JSON.stringify(COUNTER_SPEC),
  ]);
  const { container } = mount();

  ask(container, "a counter");
  // One task in: the reply has landed and the ladder is stepping.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  ask(container, "something else entirely");
  await settleUi();

  assert.equal(sent.length, 1, "the second ask never reached the provider");
});

test("AiPanel: a build can be cancelled part-way through", async () => {
  resetDom();
  const sent = stubBridge([JSON.stringify(COUNTER_SPEC)]);
  const { container, designs } = mount();

  ask(container, "a counter");
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  // The send button doubles as cancel while anything is in flight — which now
  // includes the ladder, impossible to interrupt while it was one atomic task.
  container
    .querySelector(".ai-send")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await settleUi();

  assert.equal(sent.length, 1, "no new request went out");
  assert.equal(designs.length, 0, "the abandoned build offered nothing");
  assert.match(rows(container, "note").join(" "), /Cancelled/);
  assert.equal(
    container.querySelector(".ai-row--working"),
    null,
    "and it did not leave the panel looking busy forever",
  );
});

test("AiPanel: a repair round says so while it is happening, not after", async () => {
  resetDom();
  const broken = {
    ...COUNTER_SPEC,
    tests: [{ name: "backwards", edges: 1, expect: { BAR: "00000001" } }],
  };
  stubBridge([JSON.stringify(broken), JSON.stringify(COUNTER_SPEC)]);
  const { container } = mount();

  const watch = watchWorking(container);
  ask(container, "a counter");
  await settleUi();
  await settleUi();

  assert.match(
    watch.stop(),
    /Designing the circuit \(fix 1 of 2\)/,
    "the second request names itself while it is running",
  );
});

// ── Prompt history ──────────────────────────────────────────────────────────
//
// The state machine is proven in prompt-history.test.js. What is proven here is
// the half that needs a real textarea: WHEN an arrow belongs to the text and
// when it belongs to history, and where the caret lands afterwards.

/** Press a key on the prompt box; returns whether the panel took the event. */
const press = (container, key, init = {}) => {
  const e = new window.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  container.querySelector(".ai-input").dispatchEvent(e);
  return e.defaultPrevented;
};

/** Put text in the box the way a user would, so `input` fires. */
const type = (container, text, caret = text.length) => {
  const box = container.querySelector(".ai-input");
  box.value = text;
  box.dispatchEvent(new window.Event("input", { bubbles: true }));
  box.setSelectionRange(caret, caret);
};

const promptBox = (container) => container.querySelector(".ai-input");

test("AiPanel: Up at the top of the text recalls the previous prompt", async () => {
  resetDom();
  stubBridge([JSON.stringify(COUNTER_SPEC), JSON.stringify(COUNTER_SPEC)]);
  const { container } = mount();

  ask(container, "a counter");
  await settleUi();
  ask(container, "an adder");
  await settleUi();

  const box = promptBox(container);
  assert.equal(box.value, "", "the box was emptied by sending");

  // NOTE this panel has no `onHistoryChange` — recording must not depend on
  // anyone listening for it.
  assert.equal(press(container, "ArrowUp"), true, "history took the key");
  assert.equal(box.value, "an adder", "the newest prompt first");
  assert.equal(box.selectionStart, 0, "caret at the top, ready to keep going");

  press(container, "ArrowUp");
  assert.equal(box.value, "a counter", "and back again");

  press(container, "ArrowUp");
  assert.equal(box.value, "a counter", "nothing older — the box is left alone");
});

test("AiPanel: Down walks forward and restores the unsent draft", async () => {
  resetDom();
  stubBridge([JSON.stringify(COUNTER_SPEC)]);
  const { container } = mount();

  ask(container, "a counter");
  await settleUi();

  const box = promptBox(container);
  // Caret at the top — from the END, Up belongs to the text, which is the
  // point of the rule and has its own test below.
  type(container, "half a thought", 0);
  press(container, "ArrowUp");
  assert.equal(box.value, "a counter");
  assert.equal(box.selectionStart, 0, "recalled at the top, ready for another");

  // Turning round costs one press through the recalled text, exactly as the
  // rule says it should. A real browser moves the caret to the end itself on
  // Down at the last line; jsdom implements no caret movement for arrow keys,
  // so the test does what the browser would.
  assert.equal(press(container, "ArrowDown"), false, "the text takes it first");
  const toEnd = box.value.length;
  box.setSelectionRange(toEnd, toEnd);

  assert.equal(press(container, "ArrowDown"), true, "now history takes it");
  assert.equal(box.value, "half a thought", "the draft came back intact");
  assert.equal(box.selectionStart, box.value.length, "caret at the bottom");
  assert.equal(press(container, "ArrowDown"), false, "already home");
});

test("AiPanel: an arrow moves through the text before it reaches history", () => {
  // The rule the whole feature turns on: an arrow does what an arrow does
  // until there is nowhere left for it to go IN THE TEXT.
  resetDom();
  stubBridge([]);
  const { container } = mount();
  const box = promptBox(container);
  box.value = "";
  const panelHistory = ["previous ask"];
  void panelHistory;

  type(container, "line one\nline two", 3); // mid first line
  assert.equal(press(container, "ArrowUp"), false, "not at the very start");
  assert.equal(box.value, "line one\nline two", "the text is untouched");

  box.setSelectionRange(12, 12); // mid second line
  assert.equal(press(container, "ArrowDown"), false, "not at the very end");
  assert.equal(box.value, "line one\nline two");
});

test("AiPanel: a selection is never an edge", () => {
  resetDom();
  stubBridge([]);
  const { container, panel } = mount({ history: ["previous ask"] });
  void panel;
  const box = promptBox(container);
  type(container, "some text", 0);
  box.setSelectionRange(0, 4); // caret at 0, but something is selected

  assert.equal(press(container, "ArrowUp"), false, "the textarea keeps it");
  assert.equal(box.value, "some text");
});

test("AiPanel: a modified arrow is left to the textarea", () => {
  resetDom();
  stubBridge([]);
  const { container } = mount({ history: ["previous ask"] });
  const box = promptBox(container);

  for (const mod of ["shiftKey", "altKey", "metaKey", "ctrlKey"]) {
    box.value = "";
    box.setSelectionRange(0, 0);
    assert.equal(press(container, "ArrowUp", { [mod]: true }), false, mod);
    assert.equal(box.value, "", `${mod}+Up did not recall`);
  }
});

test("AiPanel: history is seeded from settings and survives across projects", () => {
  // The point of storing it app-wide: a brand-new panel, with no conversation
  // and no project behind it, can still arrow back through what was asked
  // before.
  resetDom();
  stubBridge([]);
  const { container } = mount({ history: ["an adder", "a counter"] });
  const box = promptBox(container);

  press(container, "ArrowUp");
  assert.equal(box.value, "an adder");
  press(container, "ArrowUp");
  assert.equal(box.value, "a counter");
});

test("AiPanel: a sent prompt is reported for persisting, newest first", async () => {
  resetDom();
  stubBridge([JSON.stringify(COUNTER_SPEC)]);
  const saved = [];
  const { container } = mount({
    history: ["an older ask"],
    onHistoryChange: (entries) => saved.push(entries),
  });

  ask(container, "a counter");
  await settleUi();

  assert.equal(saved.length, 1, "reported once, on send");
  assert.deepEqual(saved[0], ["a counter", "an older ask"]);
});

test("AiPanel: editing a recalled prompt restarts the walk", () => {
  resetDom();
  stubBridge([]);
  const { container } = mount({ history: ["newest", "older"] });
  const box = promptBox(container);

  press(container, "ArrowUp");
  assert.equal(box.value, "newest");
  // Typing makes the text the user's own; the next Up should start over from
  // the newest entry rather than continuing deeper into the past.
  type(container, "newest, tweaked", 0);
  press(container, "ArrowUp");
  assert.equal(box.value, "newest", "back to the top of the list");
});

test("AiPanel: Clear forgets the conversation but never the prompt history", () => {
  resetDom();
  stubBridge([]);
  const { container } = mount({ history: ["an earlier ask"] });
  container
    .querySelectorAll(".ai-btn")
    .forEach((b) => b.textContent === "Clear" && b.click());

  press(container, "ArrowUp");
  assert.equal(
    promptBox(container).value,
    "an earlier ask",
    "the history is the user's, not the conversation's",
  );
});
