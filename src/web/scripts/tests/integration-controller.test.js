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
// jsdom tests for components/integration-controller.js — the serial
// integration while a circuit runs, as SimController's settle-boundary
// collaborator. Driven through its real seams with a stub bridge, a stub sim
// and stub lamps: Run refused with the reason (and the way to fix it), the
// ports opened with each connection's layout signature and every handshake
// refusal explained, the boundary STALLING until an Output is acknowledged
// and applying the Input that arrived meanwhile, and a failed delivery, a
// dropped port or a restarted device stopping the run by name.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { IntegrationController } =
  await import("../components/integration-controller.js");
const { PopupManager } = await import("../popup-manager.js");
const { DeskDoc } = await import("../model/desk-doc.js");
const { connectionLayout, layoutSignature } =
  await import("../model/integration.js");
const { CONNECTION_DEFAULTS, MOCK_CONNECTION } =
  await import("../model/serial-connections.js");

const NANO = {
  id: "conn-a",
  name: "Nano",
  ...CONNECTION_DEFAULTS,
  port: "/dev/cu.nano",
};

/** An Output (trigger a5, pin 1 a10) and a live Input (pin 1 a20), on the Nano. */
function design({ connection = "conn-a" } = {}) {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const out = doc.addIntegration({ kind: "output", connection, name: "Lamp" });
  const inp = doc.addIntegration({ kind: "input", connection, name: "Echo" });
  doc.plantIntegrationTag(out.id, "T", "bb1.a5");
  doc.plantIntegrationTag(out.id, "1", "bb1.a10");
  doc.plantIntegrationTag(inp.id, "1", "bb1.a20");
  return { doc, out: out.id, inp: inp.id };
}

function mount({
  connections = [NANO],
  present = ["/dev/cu.nano"],
  openResult,
  send,
} = {}) {
  const win = resetDom();
  const calls = {
    open: [],
    send: [],
    close: 0,
    settings: [],
    props: [],
    scans: 0,
    windows: [],
  };
  const notes = [];
  const dismissed = [];
  const flashes = [];
  const active = [];
  const sim = {
    stalled: false,
    stops: 0,
    wakes: 0,
    stop() {
      this.stops++;
      controller.end();
    },
    wake() {
      this.wakes++;
    },
  };
  const bridge = {
    serial: {
      ports: async () => {
        calls.scans++;
        return present.map((path) => ({ path }));
      },
      log: { open: async (...args) => calls.windows.push(args) },
      open: async (requests) => {
        calls.open.push(requests);
        return openResult ?? { ok: true };
      },
      send: (...args) => {
        calls.send.push(args);
        return send ? send(...args) : Promise.resolve({ ok: true });
      },
      close: async () => {
        calls.close++;
      },
    },
  };
  const controller = new IntegrationController({
    bridge,
    notifications: {
      notify: (n) => notes.push(n),
      dismiss: (key) => dismissed.push(key),
    },
    getConnections: () => connections,
    openSettings: (tab) => calls.settings.push(tab),
    openProperties: (id) => calls.props.push(id),
    lamps: {
      flash: (kind) => flashes.push(kind),
      setActive: (on) => active.push(on),
    },
  });
  controller.setSim(sim);
  const emit = (name, detail) =>
    win.dispatchEvent(new win.CustomEvent(`chiphippo:${name}`, { detail }));
  return { win, controller, sim, calls, notes, dismissed, flashes, active, emit }; // prettier-ignore
}

/** A settled board: every address its own net, at the levels given. */
function board(levels) {
  const netOfPoint = new Map();
  const netLevels = new Map();
  for (const [address, level] of Object.entries(levels)) {
    netOfPoint.set(address, address);
    netLevels.set(address, level);
  }
  return { netlist: { netOfPoint }, netLevels };
}

const popup = () => ({
  title: document.querySelector(".popup-title")?.textContent ?? null,
  message: document.querySelector(".popup-message")?.textContent ?? null,
  buttons: [...document.querySelectorAll(".popup-footer button")],
});
const closeAll = () => {
  while (PopupManager.isOpen()) PopupManager.close();
};
const settle = () => new Promise((r) => setTimeout(r, 0));

test("a renderer that has just loaded lets go of any port a run left open", async () => {
  const { calls } = mount();
  await settle();
  assert.equal(calls.close, 1);
});

test("preflight: a desk with no elements starts at once", () => {
  const { controller } = mount();
  assert.equal(controller.preflight(new DeskDoc(null)), true);
});

test("preflight: an element with no connection refuses, and offers its Properties", () => {
  const { controller, calls } = mount();
  const { doc, out } = design({ connection: null });
  try {
    assert.equal(controller.preflight(doc), false);
    const p = popup();
    assert.equal(p.title, "Settings need to be verified");
    assert.equal(p.message, "Lamp isn't assigned to a connection. Choose one in its Properties."); // prettier-ignore
    p.buttons.find((b) => b.textContent === "Open Properties").click();
    assert.deepEqual(calls.props, [out]);
  } finally {
    closeAll();
  }
});

test("preflight: a connection needing configuration refuses, and offers Settings ▸ Integration", () => {
  const { controller, calls } = mount({
    connections: [{ ...NANO, needsConfig: true }],
  });
  try {
    assert.equal(controller.preflight(design().doc), false);
    assert.match(popup().message, /“Nano” needs to be configured/);
    popup()
      .buttons.find((b) => b.textContent === "Open Settings")
      .click();
    assert.deepEqual(calls.settings, ["integration"]);
  } finally {
    closeAll();
  }
});

test("preflight: a connection this computer does not know refuses", () => {
  const { controller } = mount({ connections: [] });
  try {
    assert.equal(controller.preflight(design().doc), false);
    assert.match(popup().message, /isn't set up on this computer/);
  } finally {
    closeAll();
  }
});

test("preflight: a configured connection is checked against a LIVE port scan", async () => {
  const good = mount();
  assert.equal(await good.controller.preflight(design().doc), true);

  const { controller } = mount({ present: [] });
  try {
    assert.equal(await controller.preflight(design().doc), false);
    assert.equal(
      popup().message,
      "The port /dev/cu.nano for the connection “Nano” is unavailable.",
    );
  } finally {
    closeAll();
  }
});

test("begin opens every used connection with its layout signature, then lights the lamps", async () => {
  const { controller, calls, notes, dismissed, active } = mount();
  const { doc } = design();
  assert.equal(controller.begin(new DeskDoc(null)), null, "nothing to open");
  assert.equal(await controller.begin(doc), true);
  assert.deepEqual(calls.open, [
    [
      {
        id: "conn-a",
        signature: layoutSignature(doc.integrations, "conn-a"),
        layout: connectionLayout(doc.integrations, "conn-a"),
      },
    ],
  ]);
  assert.equal(notes[0].key, "integration-connect", "a Connecting toast…");
  assert.ok(dismissed.includes("integration-connect"), "…taken down after");
  assert.deepEqual(active, [true]);
  assert.equal(controller.running, true);
  assert.deepEqual(controller.connectionIds, ["conn-a"]);
});

test("each handshake refusal stops the run before it starts, and says why", async () => {
  const cases = [
    [
      { code: "no-response" },
      "No answer",
      /Nothing answered on \/dev\/cu\.nano for “Nano”/,
    ],
    [
      { code: "version", version: 2 },
      "Protocol version mismatch",
      /“Nano” speaks protocol v2; Chip Hippo speaks v1\. Generate its code again/,
    ],
    [
      { code: "signature" },
      "Sketch built for another design",
      /The code on “Nano” was built for a different design\. Generate it again/,
    ],
  ];
  for (const [result, title, message] of cases) {
    const { controller, active } = mount({
      openResult: { ok: false, id: "conn-a", ...result },
    });
    try {
      assert.equal(await controller.begin(design().doc), false);
      assert.equal(popup().title, title);
      assert.match(popup().message, message);
      assert.equal(controller.running, false);
      assert.deepEqual(active, []);
    } finally {
      closeAll();
    }
  }
});

test("the boundary STALLS on an Output until it is acknowledged, then applies what arrived", async () => {
  let ack;
  const { controller, calls, flashes, sim, emit } = mount({
    send: () => new Promise((r) => (ack = r)),
  });
  const { doc, inp } = design();
  await controller.begin(doc);

  // Trigger still low: nothing fires.
  assert.equal(
    controller.settled(board({ "bb1.a5": "L", "bb1.a10": "H" })),
    null,
  );
  // The rising edge: the Output goes out carrying pin 1's level.
  const stall = controller.settled(board({ "bb1.a5": "H", "bb1.a10": "H" }));
  assert.ok(stall instanceof Promise, "the board stalls");
  assert.deepEqual(calls.send, [["conn-a", 0, 1, 1]]);
  assert.deepEqual(flashes, ["tx"]);

  // The sketch answers with an Input while the board is stalled: it waits.
  sim.stalled = true;
  emit("serial-inbound", { id: "conn-a", index: 0, width: 1, value: 1 });
  assert.equal(sim.wakes, 0, "a stalled board is not woken");
  assert.equal(controller.levels().size, 0, "not on the board yet");
  assert.ok(flashes.includes("rx"));

  ack({ ok: true });
  assert.deepEqual(await stall, { again: true }, "applied: settle again");
  assert.deepEqual([...controller.levels()], [[`${inp}:1`, "H"]]);
});

test("a LIVE Input arriving on a quiet board wakes it", async () => {
  const { controller, sim, emit } = mount();
  await controller.begin(design().doc);
  emit("serial-inbound", { id: "conn-a", index: 0, width: 1, value: 0 });
  assert.equal(sim.wakes, 1);
  assert.deepEqual(controller.settled(board({ "bb1.a5": "L" })), {
    again: true,
  });
  emit("serial-inbound", { id: "conn-a", index: 7, width: 1, value: 0 });
  assert.equal(sim.wakes, 1, "an Input the desk does not have is ignored");
  emit("serial-inbound", { id: "conn-a", index: 0, width: 8, value: 0 });
  assert.equal(sim.wakes, 1, "…and so is one of the wrong width");
});

test("a delivery that fails stops the run, naming the connection", async () => {
  const { controller, sim } = mount({
    send: async () => ({ ok: false, code: "delivery" }),
  });
  await controller.begin(design().doc);
  controller.settled(board({ "bb1.a5": "L" }));
  try {
    const r = await controller.settled(board({ "bb1.a5": "H" }));
    assert.deepEqual(r, { again: false });
    assert.equal(sim.stops, 1);
    assert.equal(popup().title, "Delivery failed");
    assert.match(popup().message, /Delivery to “Nano” failed after 3 attempts/);
    assert.equal(controller.running, false);
  } finally {
    closeAll();
  }
});

test("a port dropped mid-run stops the run by name; after Stop it is not news", async () => {
  const { controller, sim, emit, active } = mount();
  await controller.begin(design().doc);
  try {
    emit("serial-dropped", { id: "conn-a" });
    assert.equal(sim.stops, 1);
    assert.equal(popup().title, "Connection dropped");
    assert.equal(
      popup().message,
      "The serial connection to “Nano” was dropped, so the circuit has stopped.",
    );
    assert.deepEqual(active, [true, false], "the lamps go dark");
  } finally {
    closeAll();
  }
  emit("serial-dropped", { id: "conn-a" });
  assert.equal(sim.stops, 1);
});

test("log text flashes LG; a Clear does not", async () => {
  const { controller, flashes, emit } = mount();
  await controller.begin(design().doc);
  emit("serial-log", { id: "conn-a", entries: [{ kind: "text", text: "hi" }], partial: "" }); // prettier-ignore
  emit("serial-log", { id: "conn-a", entries: [], partial: "par" });
  emit("serial-log", { id: "conn-a", entries: [], partial: "par" }); // no change
  emit("serial-log", { id: "conn-a", cleared: true, entries: [], partial: "" });
  assert.deepEqual(
    flashes.filter((k) => k === "lg"),
    ["lg", "lg"],
  );
});

test("a device restarting mid-run stops the run by name", async () => {
  const { controller, sim, emit } = mount();
  await controller.begin(design().doc);
  try {
    emit("serial-restart", { id: "conn-a" });
    assert.equal(sim.stops, 1);
    assert.equal(popup().title, "Board restarted");
    assert.match(
      popup().message,
      /“Nano” restarted while the circuit was running/,
    );
  } finally {
    closeAll();
  }
  emit("serial-restart", { id: "conn-a" });
  assert.equal(sim.stops, 1, "after Stop it is not news");
});

test("an Output failed by that restart says so once, not as a delivery failure", async () => {
  const { controller, sim, emit } = mount({
    send: async () => ({ ok: false, code: "restart" }),
  });
  await controller.begin(design().doc);
  controller.settled(board({ "bb1.a5": "L" }));
  try {
    await controller.settled(board({ "bb1.a5": "H" }));
    emit("serial-restart", { id: "conn-a" });
    assert.equal(sim.stops, 1);
    assert.equal(popup().title, "Board restarted");
  } finally {
    closeAll();
  }
});

test("Stop while an Output is in flight is not reported as a failure", async () => {
  let fail;
  const { controller, sim } = mount({
    send: () => new Promise((r) => (fail = r)),
  });
  await controller.begin(design().doc);
  controller.settled(board({ "bb1.a5": "L" }));
  const stall = controller.settled(board({ "bb1.a5": "H" }));
  controller.end(); // the user pressed Stop; closing the port fails the send
  fail({ ok: false, code: "closed" });
  assert.deepEqual(await stall, { again: false });
  assert.equal(sim.stops, 0);
  assert.equal(PopupManager.isOpen(), false);
});

test("end forgets the run and lets the ports go", async () => {
  const { controller, calls, active } = mount();
  await controller.begin(design().doc);
  await settle();
  const closesBefore = calls.close;
  controller.end();
  assert.equal(controller.running, false);
  assert.deepEqual(active, [true, false]);
  assert.equal(controller.levels().size, 0);
  assert.equal(controller.settled(board({ "bb1.a5": "H" })), null);
  await settle();
  assert.equal(calls.close, closesBefore + 1);
});

test("the Mock needs no port: preflight passes without a scan", async () => {
  const { controller, calls } = mount({
    connections: [MOCK_CONNECTION, NANO],
    present: [],
  });
  const { doc } = design({ connection: "mock" });
  assert.equal(await controller.preflight(doc), true);
  assert.equal(calls.scans, 0);
});

test("a run on the Mock opens its window in the background", async () => {
  const { controller, calls } = mount({ connections: [MOCK_CONNECTION] });
  const { doc } = design({ connection: "mock" });
  assert.equal(await controller.begin(doc), true);
  const [request] = calls.open[0];
  assert.equal(request.id, "mock");
  assert.deepEqual(request.layout, {
    outputs: [{ name: "Lamp", fields: [{ type: "bit", name: "bit0" }] }],
    inputs: [{ name: "Echo", fields: [{ type: "bit", name: "bit0" }] }],
  });
  await settle();
  assert.deepEqual(calls.windows, [["mock", { background: true }]]);
});

test("a board's run carries its layout too, but opens no window by itself", async () => {
  const { controller, calls } = mount();
  await controller.begin(design().doc);
  assert.deepEqual(calls.open[0][0].layout.outputs, [
    { name: "Lamp", fields: [{ type: "bit", name: "bit0" }] },
  ]);
  await settle();
  assert.deepEqual(calls.windows, []);
});
