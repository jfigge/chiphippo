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

// The MemoryBridge coordinates the main renderer with inspector windows through
// main's relay (Feature 190). It answers a window's `ready` with the chip's
// context, routes a `set-binding` through the controller, and streams the
// engine's live byte writes (and the final image on Stop) to the window.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { MemoryBridge } = await import("../components/memory-bridge.js");

/** A window.chiphippo.memory stub recording every relay. */
function install() {
  const calls = { open: [], toInspector: [] };
  window.chiphippo = {
    memory: {
      open: (compId, ref) => {
        calls.open.push([compId, ref]);
        return Promise.resolve(true);
      },
      toInspector: (compId, msg) => {
        calls.toInspector.push([compId, msg]);
        return Promise.resolve(true);
      },
    },
  };
  return calls;
}

const hostInbound = (compId, msg) =>
  window.dispatchEvent(
    new window.CustomEvent("chiphippo:memory-host-inbound", {
      detail: { compId, msg },
    }),
  );
const memState = (detail) =>
  window.dispatchEvent(
    new window.CustomEvent("chiphippo:mem-state", { detail }),
  );

function makeBridge({ running = false, image = null, comp } = {}) {
  const doc = {
    getComponent: (id) => (comp && comp.id === id ? comp : null),
  };
  const controller = {
    calls: [],
    setMemoryStorage(id, s) {
      this.calls.push([id, s]);
    },
  };
  const sim = { running, imageBytesOf: () => image };
  const bridge = new MemoryBridge({
    deskDoc: doc,
    sim,
    controller,
    bridge: window.chiphippo,
  });
  return { bridge, controller };
}

const romComp = (storage = null) => ({
  id: "c1",
  kind: "chip",
  ref: "rom-8k",
  params: storage ? { storage } : {},
});

test("open() only opens the window for a memory chip", () => {
  resetDom();
  const calls = install();
  const { bridge } = makeBridge({ comp: romComp() });
  bridge.open("c1");
  assert.deepEqual(calls.open, [["c1", "rom-8k"]]);

  // A non-memory component is ignored.
  const calls2 = install();
  const { bridge: b2 } = makeBridge({
    comp: { id: "c2", kind: "chip", ref: "74LS00", params: {} },
  });
  b2.open("c2");
  assert.deepEqual(calls2.open, []);
});

test("a window's `ready` gets a stopped context with no bytes", () => {
  resetDom();
  const calls = install();
  makeBridge({
    running: false,
    comp: romComp({ path: "/x.bin", mode: "rom" }),
  });

  hostInbound("c1", { kind: "ready" });
  assert.equal(calls.toInspector.length, 1);
  const [id, msg] = calls.toInspector[0];
  assert.equal(id, "c1");
  assert.equal(msg.kind, "context");
  assert.equal(msg.running, false);
  assert.deepEqual(msg.storage, { path: "/x.bin", mode: "rom" });
  assert.equal(
    msg.bytes,
    undefined,
    "the window loads the file itself while stopped",
  );
});

test("a `ready` while running hands over the live image bytes", () => {
  resetDom();
  const calls = install();
  const image = Uint8Array.from([1, 2, 3]);
  makeBridge({ running: true, image, comp: romComp() });

  hostInbound("c1", { kind: "ready" });
  const [, msg] = calls.toInspector.at(-1);
  assert.equal(msg.running, true);
  assert.deepEqual([...msg.bytes], [1, 2, 3], "the running snapshot is sent");
});

test("a `set-binding` routes through the controller and echoes context back", () => {
  resetDom();
  install();
  const { controller } = makeBridge({ comp: romComp() });
  hostInbound("c1", {
    kind: "set-binding",
    storage: { path: "/y.bin", mode: "ram" },
  });
  assert.deepEqual(controller.calls, [["c1", { path: "/y.bin", mode: "ram" }]]);
});

test("running mem-state streams per-chip byte changes to inspectors", () => {
  resetDom();
  const calls = install();
  makeBridge({ running: true, comp: romComp() });

  memState({ running: true, changes: new Map([["c1", [[5, 0xaa]]]]) });
  assert.deepEqual(calls.toInspector, [
    ["c1", { kind: "bytes", changes: [[5, 0xaa]] }],
  ]);
});

test("stopped mem-state hands each chip its final image", () => {
  resetDom();
  const calls = install();
  makeBridge({ comp: romComp({ path: "/x.bin", mode: "ram" }) });

  memState({
    running: false,
    images: new Map([["c1", Uint8Array.from([9, 8])]]),
  });
  const [id, msg] = calls.toInspector[0];
  assert.equal(id, "c1");
  assert.equal(msg.kind, "context");
  assert.equal(msg.running, false);
  assert.deepEqual([...msg.bytes], [9, 8]);
});
