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
// jsdom tests for components/integration-settings.js — Settings ▸ Serial I/O,
// the one Settings panel that does NOT apply live: a connection is a DRAFT
// until Apply, because applying is where it is verified against a live port
// scan. ONE dropdown picks the connection (+ adds, the bin removes) and ONE
// editor below edits it. Pinned: the list naming each problem and the Port
// field marking it red (the test Run applies), where the panel opens, Add arriving
// flagged and picked, drafts surviving a change of pick, Apply refusing an
// absent port until it becomes "Apply anyway", the bin taking two clicks —
// and the built-in Mock heading the list with nothing to configure, its name
// reserved.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { buildIntegrationPanel } =
  await import("../components/integration-settings.js");
const { CONNECTION_DEFAULTS } = await import("../model/serial-connections.js");

const conn = (id, name, extra = {}) => ({
  id,
  name,
  ...CONNECTION_DEFAULTS,
  ...extra,
});

const settle = () => new Promise((r) => setTimeout(r, 0));

async function mount({ connections, present = [] } = {}) {
  const win = resetDom();
  const patches = [];
  const logs = [];
  let scans = 0;
  const bridge = {
    serial: {
      ports: async () => {
        scans++;
        return present.map((path) => ({ path, manufacturer: "Arduino" }));
      },
      log: { open: async (id) => logs.push(id) },
    },
  };
  const { rows } = buildIntegrationPanel(
    { serialConnections: connections },
    (patch) => patches.push(patch),
    bridge,
  );
  const root = win.document.createElement("div");
  root.append(...rows);
  win.document.body.append(root);
  await settle(); // the opening scan
  const picker = () => root.querySelector(".integration-picker-select");
  const editor = () => root.querySelector(".integration-conn");
  const addBtn = () => root.querySelector(".integration-picker-btn:not(.integration-picker-btn--danger)"); // prettier-ignore
  const bin = () => root.querySelector(".integration-picker-btn--danger");
  const button = (label) =>
    [...editor().querySelectorAll("button")].find(
      (b) => b.textContent === label,
    );
  const set = (node, value, type = "change") => {
    node.value = value;
    node.dispatchEvent(new win.Event(type, { bubbles: true }));
  };
  const pick = (id) => set(picker(), id);
  const options = () =>
    [...picker().options].map((o) => [o.value, o.textContent]);
  const setPresent = (next) => {
    present = next;
  };
  return { win, root, picker, editor, addBtn, bin, button, set, pick, options, patches, logs, setPresent, scans: () => scans }; // prettier-ignore
}

const lastList = (patches) => patches.at(-1)?.serialConnections;
const noteText = (editor) =>
  editor.querySelector(".integration-note")?.textContent ?? null;

test("the picker lists the Mock first, then each connection, naming its problem", async () => {
  const { options } = await mount({
    connections: [
      conn("conn-a", "Nano", { port: "/dev/a" }),
      conn("conn-b", "Uno", { port: "/dev/gone" }),
      conn("conn-c", "Mega", { needsConfig: true }),
    ],
    present: ["/dev/a"],
  });
  assert.deepEqual(options(), [
    ["mock", "Mock — Built-in"],
    ["conn-a", "Nano"],
    ["conn-b", "Uno — Port unavailable"],
    ["conn-c", "Mega — Needs configuration"],
  ]);
});

test("the panel opens on the first connection with a problem, else the first of your own, else the Mock", async () => {
  const flagged = await mount({
    connections: [
      conn("conn-a", "Nano", { port: "/dev/a" }),
      conn("conn-b", "Uno", { needsConfig: true }),
    ],
    present: ["/dev/a"],
  });
  assert.equal(flagged.picker().value, "conn-b");
  assert.equal(flagged.editor().dataset.connectionId, "conn-b");

  const clean = await mount({
    connections: [
      conn("conn-a", "Nano", { port: "/dev/a" }),
      conn("conn-b", "Uno", { port: "/dev/a" }),
    ],
    present: ["/dev/a"],
  });
  assert.equal(clean.picker().value, "conn-a");

  const none = await mount({ connections: [] });
  assert.equal(none.picker().value, "mock");
  assert.equal(none.editor().dataset.connectionId, "mock");
});

test("picking a connection puts it in the one editor", async () => {
  const { editor, pick } = await mount({
    connections: [
      conn("conn-a", "Nano", { port: "/dev/a" }),
      conn("conn-b", "Uno", { port: "/dev/a" }),
    ],
    present: ["/dev/a"],
  });
  assert.equal(editor().querySelector(".integration-name").value, "Nano");
  pick("conn-b");
  assert.equal(editor().dataset.connectionId, "conn-b");
  assert.equal(editor().querySelector(".integration-name").value, "Uno");
});

const portMarked = (editor) =>
  Boolean(
    editor
      .querySelector(".integration-field--problem")
      ?.querySelector(".integration-port"),
  );

test("a port the scan did not find marks the Port field red", async () => {
  const { editor, pick } = await mount({
    connections: [
      conn("conn-a", "Nano", { port: "/dev/a" }),
      conn("conn-b", "Uno", { port: "/dev/gone" }),
    ],
    present: ["/dev/a"],
  });
  assert.equal(portMarked(editor()), false);
  pick("conn-b");
  assert.equal(portMarked(editor()), true);
  assert.match(
    editor().querySelector(".integration-port").selectedOptions[0].textContent,
    /\/dev\/gone \(not found\)/,
    "the stored port stays selectable, labelled as missing",
  );
});

test("the port list is the scan's, each device named with its manufacturer", async () => {
  const { editor } = await mount({
    connections: [conn("conn-a", "Nano", { port: "/dev/a" })],
    present: ["/dev/a", "/dev/b"],
  });
  const labels = [...editor().querySelector(".integration-port").options].map((o) => o.textContent); // prettier-ignore
  assert.deepEqual(labels, [
    "— choose a port —",
    "/dev/a — Arduino",
    "/dev/b — Arduino",
  ]);
});

test("+ emits a patch with a new FLAGGED connection, picks it, and puts the caret in its name", async () => {
  const { win, picker, editor, addBtn, patches, options } = await mount({
    connections: [conn("conn-a", "Arduino", { port: "/dev/a" })],
    present: ["/dev/a"],
  });
  assert.equal(addBtn().getAttribute("aria-label"), "Add connection");
  addBtn().click();
  const list = lastList(patches);
  assert.equal(list.length, 2);
  const added = list[1];
  assert.equal(added.needsConfig, true);
  assert.equal(added.name, "Arduino 2", "a unique name");
  assert.equal(added.port, "");
  assert.equal(picker().value, added.id);
  assert.deepEqual(options().at(-1), [added.id, "Arduino 2 — Needs configuration"]); // prettier-ignore
  assert.equal(portMarked(editor()), true);
  assert.equal(
    win.document.activeElement,
    editor().querySelector(".integration-name"),
  );
});

test("edits are a DRAFT: nothing is emitted until Apply, and the list marks the unapplied one", async () => {
  const { editor, button, set, patches, options } = await mount({
    connections: [conn("conn-a", "Nano", { port: "/dev/a" })],
    present: ["/dev/a", "/dev/b"],
  });
  assert.equal(button("Apply").disabled, true, "nothing to apply");
  set(editor().querySelector(".integration-port"), "/dev/b");
  assert.equal(patches.length, 0);
  assert.ok(editor().classList.contains("integration-conn--dirty"));
  assert.equal(button("Apply").disabled, false);
  assert.deepEqual(options()[1], ["conn-a", "Nano •"]);
  button("Apply").click();
  await settle();
  await settle();
  assert.equal(lastList(patches)[0].port, "/dev/b");
  assert.equal(noteText(editor()), "Applied.");
  assert.ok(!editor().classList.contains("integration-conn--dirty"));
  assert.deepEqual(options()[1], ["conn-a", "Nano"]);
});

test("typing a name edits the draft in place — the field is never rebuilt under the caret", async () => {
  const { win, editor, set, patches, options } = await mount({
    connections: [conn("conn-a", "Nano", { port: "/dev/a" })],
    present: ["/dev/a"],
  });
  const name = editor().querySelector(".integration-name");
  name.focus();
  set(name, "Nano v3", "input");
  assert.equal(editor().querySelector(".integration-name"), name, "same node");
  assert.equal(win.document.activeElement, name, "still focused");
  assert.equal(patches.length, 0);
  assert.deepEqual(options()[1], ["conn-a", "Nano •"], "the stored name until Apply"); // prettier-ignore
});

test("a draft survives picking another connection and coming back", async () => {
  const { editor, set, pick, patches } = await mount({
    connections: [
      conn("conn-a", "Nano", { port: "/dev/a" }),
      conn("conn-b", "Uno", { port: "/dev/a" }),
    ],
    present: ["/dev/a", "/dev/b"],
  });
  set(editor().querySelector(".integration-port"), "/dev/b");
  pick("conn-b");
  assert.equal(editor().querySelector(".integration-port").value, "/dev/a");
  pick("conn-a");
  assert.equal(editor().querySelector(".integration-port").value, "/dev/b");
  assert.ok(editor().classList.contains("integration-conn--dirty"));
  assert.equal(patches.length, 0);
});

test("Apply clears the needs-configuration flag", async () => {
  const { editor, button, set, patches, options } = await mount({
    connections: [conn("conn-a", "Nano", { needsConfig: true })],
    present: ["/dev/a"],
  });
  set(editor().querySelector(".integration-port"), "/dev/a");
  button("Apply").click();
  await settle();
  await settle();
  const applied = lastList(patches)[0];
  assert.equal(applied.port, "/dev/a");
  assert.notEqual(applied.needsConfig, true);
  assert.deepEqual(options()[1], ["conn-a", "Nano"]);
  assert.equal(portMarked(editor()), false);
});

test("Apply with no port refuses and says why", async () => {
  const { editor, button, patches } = await mount({
    connections: [conn("conn-a", "Nano", { needsConfig: true })],
  });
  button("Apply").click();
  await settle();
  assert.equal(patches.length, 0);
  assert.equal(
    editor().querySelector(".integration-note--warn").textContent,
    "Choose a port first.",
  );
});

test("Apply re-scans; an absent port is warned about, and Apply becomes 'Apply anyway'", async () => {
  const { editor, button, set, patches, setPresent, scans } = await mount({
    connections: [conn("conn-a", "Nano", { port: "/dev/a" })],
    present: ["/dev/a", "/dev/b"],
  });
  set(editor().querySelector(".integration-port"), "/dev/b");
  setPresent(["/dev/a"]); // unplugged between the scan and the Apply
  const before = scans();
  button("Apply").click();
  await settle();
  await settle();
  assert.equal(scans(), before + 1, "Apply scans live");
  assert.equal(patches.length, 0, "not applied");
  assert.equal(
    editor().querySelector(".integration-note--warn").textContent,
    "/dev/b isn't connected right now.",
  );
  assert.equal(button("Apply"), undefined, "one apply button, not two");
  button("Apply anyway").click();
  await settle();
  assert.equal(scans(), before + 1, "the override does not scan again");
  assert.equal(lastList(patches)[0].port, "/dev/b");
});

test("an edit clears the warning, and 'Apply anyway' goes back to Apply", async () => {
  const { editor, button, set, setPresent } = await mount({
    connections: [conn("conn-a", "Nano", { port: "/dev/a" })],
    present: ["/dev/a", "/dev/b"],
  });
  set(editor().querySelector(".integration-port"), "/dev/b");
  setPresent(["/dev/a"]);
  button("Apply").click();
  await settle();
  await settle();
  assert.ok(button("Apply anyway"));
  set(editor().querySelector(".integration-port"), "/dev/a");
  assert.equal(editor().querySelector(".integration-note"), null);
  assert.ok(button("Apply"));
  assert.equal(button("Apply anyway"), undefined);
});

test("the bin takes two clicks, and the neighbour takes the removed one's place", async () => {
  const { root, bin, picker, patches, options } = await mount({
    connections: [
      conn("conn-a", "Nano", { port: "/dev/a" }),
      conn("conn-b", "Uno", { port: "/dev/a" }),
    ],
    present: ["/dev/a"],
  });
  assert.equal(bin().getAttribute("aria-label"), "Remove connection");
  bin().click();
  assert.equal(patches.length, 0);
  assert.ok(bin().classList.contains("integration-picker-btn--armed"));
  assert.equal(
    bin().getAttribute("aria-label"),
    "Click again to remove this connection",
  );
  bin().click();
  assert.deepEqual(
    lastList(patches).map((c) => c.id),
    ["conn-b"],
  );
  assert.equal(picker().value, "conn-b", "the next one down");
  assert.ok(!bin().classList.contains("integration-picker-btn--armed"));
  assert.deepEqual(
    options().map(([id]) => id),
    ["mock", "conn-b"],
  );

  // The last of them leaves the Mock picked.
  bin().click();
  bin().click();
  assert.deepEqual(lastList(patches), []);
  assert.equal(picker().value, "mock");
  assert.equal(root.querySelector(".integration-conn").dataset.connectionId, "mock"); // prettier-ignore
});

test("the bin disarms on a click elsewhere, on Escape (which the dialog never sees), and on a change of pick", async () => {
  const { win, root, bin, pick, patches } = await mount({
    connections: [
      conn("conn-a", "Nano", { port: "/dev/a" }),
      conn("conn-b", "Uno", { port: "/dev/a" }),
    ],
    present: ["/dev/a"],
  });
  const armed = () => bin().classList.contains("integration-picker-btn--armed");

  bin().click();
  assert.ok(armed());
  root
    .querySelector(".integration-name")
    .dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
  assert.ok(!armed(), "a click elsewhere");

  bin().click();
  let reachedDialog = false;
  const onKey = (e) => {
    reachedDialog = true;
    assert.ok(e.defaultPrevented);
  };
  win.document.body.addEventListener("keydown", onKey);
  const esc = new win.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  root.querySelector(".integration-name").dispatchEvent(esc);
  win.document.body.removeEventListener("keydown", onKey);
  assert.ok(!armed(), "Escape");
  assert.ok(esc.defaultPrevented, "the <dialog> is not closed by it");
  assert.equal(reachedDialog, false);

  bin().click();
  pick("conn-b");
  assert.ok(!armed(), "a change of pick");
  bin().click();
  assert.equal(patches.length, 0, "and each first click only arms");
});

test("Open window… opens the picked connection's window", async () => {
  const { button, logs, pick } = await mount({
    connections: [conn("conn-a", "Nano", { port: "/dev/a" })],
    present: ["/dev/a"],
  });
  button("Open window…").click();
  pick("mock");
  button("Open window…").click();
  assert.deepEqual(logs, ["conn-a", "mock"]);
});

test("the Mock: one line of explanation and its window — nothing to configure, nothing to remove", async () => {
  const { editor, bin, logs } = await mount({ connections: [] });
  const mock = editor();
  assert.equal(mock.dataset.connectionId, "mock");
  assert.equal(
    mock.querySelector(".integration-mock-note").textContent,
    "Simulates a device on this connection. Nothing is sent to hardware.",
  );
  assert.equal(mock.querySelector("select, input"), null, "no settings");
  assert.deepEqual(
    [...mock.querySelectorAll("button")].map((b) => b.textContent),
    ["Open window…"],
    "no Apply",
  );
  assert.equal(bin().disabled, true, "no Remove");
  mock.querySelector("button").click();
  assert.deepEqual(logs, ["mock"]);
});

test("a connection may not take the Mock's name", async () => {
  const { editor, button, set, patches } = await mount({
    connections: [conn("conn-a", "Nano", { port: "/dev/a" })],
    present: ["/dev/a"],
  });
  set(editor().querySelector(".integration-name"), " mock ", "input");
  button("Apply").click();
  await settle();
  assert.equal(patches.length, 0);
  assert.equal(
    editor().querySelector(".integration-note--warn").textContent,
    "“Mock” is the built-in connection's name. Choose another.",
  );
});

test("Advanced stays open across a re-render and a change of pick", async () => {
  const { win, editor, set, pick } = await mount({
    connections: [
      conn("conn-a", "Nano", { port: "/dev/a" }),
      conn("conn-b", "Uno", { port: "/dev/a" }),
    ],
    present: ["/dev/a"],
  });
  const adv = editor().querySelector(".integration-advanced");
  adv.open = true;
  adv.dispatchEvent(new win.Event("toggle"));
  set(editor().querySelector("#set-serial-baud"), "57600");
  assert.equal(editor().querySelector(".integration-advanced").open, true);
  pick("conn-b");
  assert.equal(editor().querySelector(".integration-advanced").open, true);
});

test("what a connection is for sits behind an (i), not printed", async () => {
  const { root } = await mount({ connections: [] });
  const note = root.querySelector(".integration-picker .settings-note");
  assert.equal(
    note.textContent,
    "Named serial connections to Arduino boards. Output and Input elements pick one in their Properties.",
  );
  assert.equal(note.hidden, true);
  root.querySelector(".integration-picker .info-btn").click();
  assert.equal(note.hidden, false);
});

test("the editor is built from the card's own rows, each label tied to its control", async () => {
  const { win, editor } = await mount({
    connections: [conn("conn-a", "Nano", { port: "/dev/a" })],
    present: ["/dev/a"],
  });
  const rows = [...editor().querySelectorAll(".settings-row--field")];
  assert.deepEqual(
    rows.map((r) => r.querySelector(".settings-label").textContent),
    [
      "Name",
      "Port",
      "Baud rate",
      "Language",
      // No "Data bits": the link is binary, so it is always 8.
      "Parity",
      "Stop bits",
      "Flow control",
    ],
  );
  // And no software flow control: XON/XOFF would swallow 0x11, a frame type.
  assert.deepEqual(
    [...win.document.querySelectorAll("#set-serial-flow-control option")].map(
      (o) => o.value,
    ),
    ["none", "hardware"],
  );
  for (const row of rows) {
    const label = row.querySelector(".settings-label");
    assert.ok(row.classList.contains("settings-row"));
    // A segmented track is not labelable; it names itself instead.
    const track = row.querySelector(".segmented-picker");
    if (track) {
      assert.equal(label.htmlFor, "");
      assert.equal(track.getAttribute("aria-label"), label.textContent);
      continue;
    }
    assert.ok(
      win.document.getElementById(label.htmlFor),
      `${label.textContent} names a control`,
    );
  }
  assert.ok(editor().querySelector(".settings-row--actions #set-serial-apply"));
});

test("Language: C++ by default; Python is a draft until Apply, like every other field", async () => {
  const { root, editor, button, patches, options } = await mount({
    connections: [conn("conn-a", "Nano", { port: "/dev/a" })],
    present: ["/dev/a"],
  });
  const row = [...editor().querySelectorAll(".settings-row--field")].find(
    (r) => r.querySelector(".settings-label").textContent === "Language",
  );
  const segments = () => [...row.querySelectorAll(".segmented-option")];
  assert.deepEqual(
    segments().map((b) => [b.textContent, b.getAttribute("aria-checked")]),
    [
      ["C++", "true"],
      ["Python", "false"],
    ],
  );
  // It explains itself behind an (i), as every Settings note does.
  const note = row.querySelector(".settings-note");
  assert.equal(note.hidden, true);
  row.querySelector(".info-btn").click();
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /MicroPython and CircuitPython/);

  segments()[1].click();
  assert.equal(patches.length, 0, "nothing emitted yet");
  assert.deepEqual(options()[1], ["conn-a", "Nano •"]);
  button("Apply").click();
  await settle();
  await settle();
  assert.equal(patches.at(-1).serialConnections[0].language, "python");
  const picked = root.querySelector('.segmented-option[aria-checked="true"]');
  assert.equal(picked.textContent, "Python", "and the rebuilt row shows it");
});

test("a board with two ports says which is which — and, for Python, which is CircuitPython's data port", async () => {
  const win = resetDom();
  const bridge = {
    serial: {
      ports: async () => [
        {
          path: "/dev/cu.usbmodem1103",
          manufacturer: "Adafruit",
          serialNumber: "DF60",
        },
        {
          path: "/dev/cu.usbmodem1101",
          manufacturer: "Adafruit",
          serialNumber: "DF60",
        },
        { path: "/dev/cu.usbserial-10", manufacturer: "FTDI" },
      ],
      log: { open: async () => {} },
    },
  };
  const { rows } = buildIntegrationPanel(
    {
      serialConnections: [
        conn("conn-a", "Feather", { port: "/dev/cu.usbmodem1103" }),
      ],
    },
    () => {},
    bridge,
  );
  const root = win.document.createElement("div");
  root.append(...rows);
  win.document.body.append(root);
  await settle();
  const port = root.querySelector(".integration-port");
  const labels = () => [...port.options].map((o) => o.textContent);
  assert.deepEqual(labels().slice(1), [
    "/dev/cu.usbmodem1103 — Adafruit · port 2 of 2",
    "/dev/cu.usbmodem1101 — Adafruit · port 1 of 2",
    "/dev/cu.usbserial-10 — FTDI",
  ]);

  // Switch the Language to Python: the same select relabels in place.
  const python = [...root.querySelectorAll(".segmented-option")].find(
    (b) => b.textContent === "Python",
  );
  python.click();
  assert.equal(root.querySelector(".integration-port"), port, "not rebuilt");
  assert.deepEqual(labels().slice(1), [
    "/dev/cu.usbmodem1103 — Adafruit · port 2 of 2: CircuitPython data",
    "/dev/cu.usbmodem1101 — Adafruit · port 1 of 2: REPL",
    "/dev/cu.usbserial-10 — FTDI",
  ]);
  assert.equal(port.value, "/dev/cu.usbmodem1103", "still the chosen port");
});
