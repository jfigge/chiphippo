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

// Tests for components/serial-log-view.js — the body of a connection window.
// Pinned: every entry is a line of its kind (log, data, protocol, error) with
// a one-character prefix and a time column; the footer's filters and
// Timestamps are a VIEW — classes, not a rebuild — remembered through
// onViewChange, with errors never hidden; the partial line at the bottom;
// the placeholder; a data line's raw bytes on hover; Clear; Save… writing
// every line with its time whatever is shown; and the row cap, which is
// main's stream cap.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { resetDom } from "./jsdom-setup.js";

const { MAX_ROWS, SerialLogView, VIEW_DEFAULTS } =
  await import("../components/serial-log-view.js");

const T0 = 1_000_000;

const ENTRIES = [
  { kind: "proto", event: "open", port: "/dev/cu.nano", t: T0 },
  {
    kind: "data",
    dir: "out",
    seq: 1,
    index: 0,
    width: 9,
    value: 0x13f,
    raw: [0x7e, 0x10],
    element: {
      name: "Bus",
      fields: [
        { type: "byte", name: "addr" },
        { type: "bit", name: "rw" },
      ],
    },
    t: T0 + 12,
  },
  { kind: "proto", event: "ack-in", seq: 1, t: T0 + 13 },
  { kind: "text", text: "got it", t: T0 + 14 },
  { kind: "error", event: "resend", cause: "nak", seq: 2, attempt: 2, max: 3, t: T0 + 1500 }, // prettier-ignore
];

function mount({ view, save } = {}) {
  const win = resetDom();
  const root = win.document.createElement("div");
  win.document.body.append(root);
  const calls = { clear: 0, views: [], saved: [] };
  const logView = new SerialLogView(root, {
    view,
    onClear: () => calls.clear++,
    onViewChange: (v) => calls.views.push(v),
    onSave: async (text) => {
      calls.saved.push(text);
      return save === undefined ? { ok: true, path: "/tmp/nano.txt" } : save;
    },
  });
  const q = (sel) => root.querySelector(sel);
  const qa = (sel) => [...root.querySelectorAll(sel)];
  const rows = () => qa(".serial-log-lines > .serial-log-line");
  const texts = () => rows().map((r) => r.querySelector(".serial-log-text").textContent); // prettier-ignore
  const box = (label) =>
    qa(".serial-log-toggle").find((l) => l.textContent === label).querySelector("input"); // prettier-ignore
  const scroller = q(".serial-log-scroll");
  return { win, root, view: logView, calls, q, qa, rows, texts, box, scroller };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test("each entry is a line of its kind, with its prefix", () => {
  const { view, rows, texts } = mount();
  view.reset(ENTRIES, "", T0);
  assert.deepEqual(
    rows().map((r) => [
      [...r.classList].find((c) => /--(log|data|protocol|error)$/.test(c)),
      r.querySelector(".serial-log-prefix").textContent,
    ]),
    [
      ["serial-log-line--protocol", "·"],
      ["serial-log-line--data", "→"],
      ["serial-log-line--protocol", "·"],
      ["serial-log-line--log", ""],
      ["serial-log-line--error", "!"],
    ],
  );
  assert.deepEqual(texts(), [
    "Port /dev/cu.nano opened",
    "OUTPUT   Bus  addr=0x3F rw=1",
    "← ACK seq 1",
    "got it",
    "← NAK — resending seq 2 (attempt 2/3)",
  ]);
  assert.ok(rows()[1].classList.contains("serial-log-line--out"));
});

test("a data line shows its raw bytes on hover", () => {
  const { view, rows } = mount();
  view.reset(ENTRIES, "", T0);
  assert.equal(rows()[1].title, "7E 10");
  assert.equal(rows()[0].title, "");
});

test("the time column counts from the run's start, and Timestamps shows it live", () => {
  const { view, rows, box, scroller, calls } = mount();
  view.reset(ENTRIES, "", T0);
  assert.equal(
    rows()[4].querySelector(".serial-log-time").textContent,
    "+   1.500",
  );
  assert.equal(scroller.classList.contains("serial-log--times"), false);
  const ts = box("Timestamps");
  ts.checked = true;
  ts.dispatchEvent(new Event("change"));
  assert.equal(scroller.classList.contains("serial-log--times"), true);
  assert.deepEqual(calls.views.at(-1), { ...VIEW_DEFAULTS, timestamps: true });
});

test("filters default to Log and Data on, Protocol off — and a toggle is a class, not a rebuild", () => {
  const { view, box, scroller, rows, calls } = mount();
  view.reset(ENTRIES, "", T0);
  assert.equal(box("Log").checked, true);
  assert.equal(box("Data").checked, true);
  assert.equal(box("Protocol").checked, false);
  assert.ok(scroller.classList.contains("serial-log--hide-protocol"));
  const before = rows()[0];
  const data = box("Data");
  data.checked = false;
  data.dispatchEvent(new Event("change"));
  assert.ok(scroller.classList.contains("serial-log--hide-data"));
  assert.equal(rows()[0], before, "the same nodes: filtering is a view");
  assert.deepEqual(calls.views.at(-1), { ...VIEW_DEFAULTS, data: false });
  // Errors have no filter at all.
  assert.equal(
    [...scroller.classList].some((c) => c.includes("error")),
    false,
  );
});

test("the remembered view is applied on opening", () => {
  const { box, scroller } = mount({
    view: { log: false, data: true, protocol: true, timestamps: true },
  });
  assert.equal(box("Log").checked, false);
  assert.equal(box("Protocol").checked, true);
  assert.ok(scroller.classList.contains("serial-log--hide-log"));
  assert.ok(!scroller.classList.contains("serial-log--hide-protocol"));
  assert.ok(scroller.classList.contains("serial-log--times"));
});

test("the partial line sits at the bottom as a log line; the placeholder only while there is nothing", () => {
  const { view, q } = mount();
  const empty = q(".serial-log-empty");
  const partial = q(".serial-log-partial");
  view.reset([], "", null);
  assert.equal(empty.hidden, false);
  view.append([], "half a li");
  assert.equal(empty.hidden, true);
  assert.equal(partial.hidden, false);
  assert.equal(
    partial.querySelector(".serial-log-text").textContent,
    "half a li",
  );
  assert.ok(partial.classList.contains("serial-log-line--log"));
  view.append([{ kind: "text", text: "half a line", t: 1 }], "");
  assert.equal(partial.hidden, true);
});

test("a reset starts the window over — a run beginning, or a Clear", () => {
  const { view, rows, q, calls } = mount();
  view.reset(ENTRIES, "", T0);
  view.reset([ENTRIES[0]], "", T0 + 99);
  assert.equal(rows().length, 1);
  q(".serial-log-clear").click();
  assert.equal(calls.clear, 1);
});

test("Save… writes every line with its time, whatever the filters show", async () => {
  const { view, q, calls } = mount();
  view.reset(ENTRIES, "and a partial", T0);
  q(".serial-log-save").click();
  await settle();
  assert.equal(calls.saved.length, 1);
  const lines = calls.saved[0].trimEnd().split("\n");
  assert.equal(lines.length, 6);
  assert.equal(lines[0], "+   0.000  ·  Port /dev/cu.nano opened");
  assert.equal(
    lines[2],
    "+   0.013  ·  ← ACK seq 1",
    "a Protocol line though Protocol is off",
  );
  assert.equal(lines[3], "+   0.014     got it");
  assert.match(lines[5], /and a partial$/);
  assert.equal(q(".serial-log-note").textContent, "Saved to /tmp/nano.txt");
});

test("a failed save says why; a cancelled one says nothing", async () => {
  const failed = mount({ save: { ok: false, error: "EACCES" } });
  failed.q(".serial-log-save").click();
  await settle();
  assert.equal(
    failed.q(".serial-log-note").textContent,
    "Couldn't save: EACCES",
  );
  const cancelled = mount({ save: null });
  cancelled.q(".serial-log-save").click();
  await settle();
  assert.equal(cancelled.q(".serial-log-note").textContent, "");
});

test("an entry of a kind this build does not know is skipped", () => {
  const { view, rows } = mount();
  view.reset(
    [
      { kind: "someday", t: 1 },
      { kind: "text", text: "ok", t: 2 },
    ],
    "",
  );
  assert.equal(rows().length, 1);
});

test("the window keeps at most 2,000 rows, dropping the oldest", () => {
  const { view, rows, texts } = mount();
  assert.equal(MAX_ROWS, 2000);
  const many = Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({
    kind: "text",
    text: `line ${i}`,
    t: i,
  }));
  view.reset(many, "", 0);
  assert.equal(rows().length, MAX_ROWS);
  assert.equal(texts()[0], "line 5");
});

test("rows appended past the cap push the oldest off the top", () => {
  const { view, rows, texts } = mount();
  const line = (i) => ({ kind: "text", text: `line ${i}`, t: i });
  view.reset(
    Array.from({ length: MAX_ROWS }, (_, i) => line(i)),
    "",
    0,
  );
  view.append([line(MAX_ROWS), line(MAX_ROWS + 1)], "");
  assert.equal(rows().length, MAX_ROWS);
  assert.equal(texts()[0], "line 2");
  assert.equal(texts().at(-1), `line ${MAX_ROWS + 1}`);
});

test("the window's row cap IS main's stream cap", () => {
  // Two numbers, one on each side of the bridge. Were they to differ, a window
  // reopened mid-run would show a different history from the one left open.
  const require = createRequire(import.meta.url);
  const { MAX_ENTRIES } = require("../../../app/serial/connection-stream.js");
  assert.equal(MAX_ROWS, MAX_ENTRIES);
});

test("the checkboxes sit together on the left, the note's slack before the buttons", () => {
  const { q } = mount();
  const footer = q(".serial-log-footer");
  assert.deepEqual(
    [...footer.children].map((c) => c.className.split(" ").at(-1)),
    [
      "serial-log-toggle",
      "serial-log-toggle",
      "serial-log-toggle",
      "serial-log-toggle",
      "serial-log-gap",
      "serial-log-clear",
      "serial-log-save",
    ],
  );
});

test("the minimum width is the footer's controls with the slack closed", () => {
  const { view, q } = mount();
  const footer = q(".serial-log-footer");
  footer.style.padding = "0 12px";
  footer.style.columnGap = "10px";
  for (const [i, child] of [...footer.children].entries()) {
    child.getBoundingClientRect = () => ({ width: 100 + i });
  }
  // Seven children, six gaps; the slack (child 4) counts for nothing.
  const controls = [0, 1, 2, 3, 5, 6].reduce((sum, i) => sum + 100 + i, 0);
  assert.equal(view.minWidth, 24 + 6 * 10 + controls);
});
