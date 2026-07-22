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
// main's relay (Feature 190). It answers `ready` with a chip's context (ROM →
// its GUID + path, no bytes while stopped; the live image while running), runs
// the external PROGRAMMER (pick → mem.program → flag programmed → reload), warns
// on a lost file, and streams live byte writes.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { MemoryBridge } = await import("../components/memory-bridge.js");

const GUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const settle = () => new Promise((r) => setTimeout(r, 5));

/** A window.chiphippo stub recording every relay + file op. */
function install({ files = new Map(), picked } = {}) {
  const calls = {
    open: [],
    toInspector: [],
    create: [],
    path: [],
    pickImage: 0,
    program: [],
    write: [],
  };
  window.chiphippo = {
    memory: {
      open: (c, r) => (calls.open.push([c, r]), Promise.resolve(true)),
      toInspector: (c, m) => (
        calls.toInspector.push([c, m]),
        Promise.resolve(true)
      ),
    },
    mem: {
      create: (g, l) => {
        calls.create.push([g, l]);
        const existed = files.has(g);
        if (!existed) files.set(g, new Uint8Array(l));
        return Promise.resolve({ ok: true, created: !existed });
      },
      load: (g, l) => Promise.resolve({ ok: true, bytes: new Uint8Array(l) }),
      path: (g) => (
        calls.path.push(g),
        Promise.resolve({ ok: true, path: `/mem/${g}.bin` })
      ),
      pickImage: () => (calls.pickImage++, Promise.resolve(picked ?? null)),
      program: (g, b, l) => (
        calls.program.push([g, l]),
        Promise.resolve({ ok: true })
      ),
      write: (g, b) => (
        calls.write.push([g, [...b]]),
        Promise.resolve({ ok: true })
      ),
    },
  };
  return { calls, files };
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
  const doc = { getComponent: (id) => (comp && comp.id === id ? comp : null) };
  const controller = {
    calls: [],
    setMemoryProgrammed(id, v) {
      this.calls.push([id, v]);
    },
  };
  const sim = { running, imageBytesOf: () => image };
  const notifications = {
    calls: [],
    notify: (o) => notifications.calls.push(o),
  };
  const bridge = new MemoryBridge({
    deskDoc: doc,
    sim,
    controller,
    bridge: window.chiphippo,
    notifications,
  });
  return { bridge, controller, notifications };
}

const rom = (params = {}) => ({
  id: "c1",
  kind: "chip",
  ref: "rom-8k",
  params,
});
const sram = (params = {}) => ({
  id: "c1",
  kind: "chip",
  ref: "ram-8k",
  params,
});

test("open() only opens the window for a memory chip", () => {
  resetDom();
  const { calls } = install();
  makeBridge({ comp: rom({ storage: { guid: GUID } }) }).bridge.open("c1");
  assert.deepEqual(calls.open, [["c1", "rom-8k"]]);

  const calls2 = install().calls;
  makeBridge({
    comp: { id: "c2", kind: "chip", ref: "74LS00", params: {} },
  }).bridge.open("c2");
  assert.deepEqual(calls2.open, []);
});

test("a ROM's `ready` ensures its file, then sends a stopped context (path, no bytes)", async () => {
  resetDom();
  const { calls } = install({ files: new Map([[GUID, new Uint8Array(8192)]]) });
  makeBridge({ running: false, comp: rom({ storage: { guid: GUID } }) });

  hostInbound("c1", { kind: "ready" });
  await settle();
  assert.deepEqual(calls.create, [[GUID, 8192]], "ensured the file exists");
  const ctx = calls.toInspector.at(-1)[1];
  assert.equal(ctx.kind, "context");
  assert.equal(ctx.volatile, false);
  assert.equal(ctx.guid, GUID);
  assert.equal(ctx.path, `/mem/${GUID}.bin`, "carries the display path");
  assert.equal(
    ctx.bytes,
    undefined,
    "the window loads the file itself while stopped",
  );
});

test("a `ready` while running hands over the live image bytes", async () => {
  resetDom();
  const { calls } = install({ files: new Map([[GUID, new Uint8Array(8192)]]) });
  makeBridge({
    running: true,
    image: Uint8Array.from([1, 2, 3]),
    comp: rom({ storage: { guid: GUID } }),
  });

  hostInbound("c1", { kind: "ready" });
  await settle();
  const ctx = calls.toInspector.at(-1)[1];
  assert.equal(ctx.running, true);
  assert.deepEqual([...ctx.bytes], [1, 2, 3]);
});

test("a lost file (created for a programmed chip) warns of data loss", async () => {
  resetDom();
  install(); // empty table → create() reports created:true
  const { notifications } = makeBridge({
    comp: rom({ storage: { guid: GUID }, programmed: true }),
  });

  hostInbound("c1", { kind: "ready" });
  await settle();
  assert.ok(
    notifications.calls.some(
      (c) => c.variant === "danger" && /data lost/i.test(c.title),
    ),
  );
});

test("the programmer picks an image, writes it, flags the chip, reloads", async () => {
  resetDom();
  const { calls } = install({
    files: new Map([[GUID, new Uint8Array(8192)]]),
    picked: { ok: true, name: "prog.bin", bytes: new Uint8Array(8192) },
  });
  const { bridge, controller } = makeBridge({
    comp: rom({ storage: { guid: GUID } }),
  });

  await bridge.program("c1");
  assert.equal(calls.pickImage, 1, "opened the picker");
  assert.deepEqual(calls.program, [[GUID, 8192]], "programmed the file");
  assert.deepEqual(
    controller.calls,
    [["c1", true]],
    "flagged the chip programmed",
  );
  assert.ok(
    calls.toInspector.some(([, m]) => m.kind === "context"),
    "reloaded the window",
  );
});

test("the programmer warns on a size mismatch but still programs", async () => {
  resetDom();
  const { calls } = install({
    files: new Map([[GUID, new Uint8Array(8192)]]),
    picked: { ok: true, name: "small.bin", bytes: new Uint8Array(100) },
  });
  const { bridge, notifications } = makeBridge({
    comp: rom({ storage: { guid: GUID } }),
  });

  await bridge.program("c1");
  assert.ok(notifications.calls.some((c) => /size mismatch/i.test(c.title)));
  assert.equal(calls.program.length, 1, "still writes the (short) image");
});

test("the programmer is a no-op for a volatile SRAM (no file)", async () => {
  resetDom();
  const { calls } = install({
    picked: { ok: true, name: "x.bin", bytes: new Uint8Array(8192) },
  });
  const { bridge } = makeBridge({ comp: sram({}) });

  await bridge.program("c1");
  assert.equal(calls.pickImage, 0, "never even opens the picker");
  assert.deepEqual(calls.program, []);
});

test("a save writes the file and flags the chip programmed", async () => {
  resetDom();
  const { calls } = install({ files: new Map([[GUID, new Uint8Array(8192)]]) });
  const { controller } = makeBridge({ comp: rom({ storage: { guid: GUID } }) });

  hostInbound("c1", { kind: "save", bytes: [1, 2, 3] });
  await settle();
  assert.deepEqual(calls.write, [[GUID, [1, 2, 3]]]);
  assert.deepEqual(controller.calls, [["c1", true]]);
});

test("running mem-state streams per-chip byte changes to inspectors", () => {
  resetDom();
  const { calls } = install();
  makeBridge({ running: true, comp: rom({ storage: { guid: GUID } }) });

  memState({ running: true, changes: new Map([["c1", [[5, 0xaa]]]]) });
  assert.deepEqual(calls.toInspector, [
    ["c1", { kind: "bytes", changes: [[5, 0xaa]] }],
  ]);
});

test("stopped mem-state hands a volatile chip its final image bytes", async () => {
  resetDom();
  const { calls } = install();
  makeBridge({ comp: sram({}) });

  memState({
    running: false,
    images: new Map([["c1", Uint8Array.from([9, 8])]]),
  });
  await settle();
  const ctx = calls.toInspector.at(-1)[1];
  assert.equal(ctx.kind, "context");
  assert.equal(ctx.volatile, true);
  assert.deepEqual([...ctx.bytes], [9, 8]);
});
