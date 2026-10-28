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
    programBytes: [],
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
        // Kept apart from the tuple above so the many tests that assert the
        // `[guid, byteLength]` shape stay readable — this is what proves an
        // Intel HEX pick was PARSED rather than written as its own text.
        calls.programBytes.push(b),
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

function makeBridge({
  running = false,
  image = null,
  comp,
  whereNow,
  markKept,
  onImagesChanged,
} = {}) {
  // prettier-ignore
  const doc = { getComponent: (id) => (comp && comp.id === id ? comp : null) };
  const controller = {
    calls: [],
    setMemoryProgrammed(id, v, binding, opts) {
      this.calls.push(opts ? [id, v, binding, opts] : [id, v, binding]);
      return true;
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
    whereNow,
    markKept,
    onImagesChanged,
  });
  return { bridge, controller, notifications, sim };
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
  assert.equal(ctx.source, null, "never programmed, so no image file to name");
  assert.equal(ctx.edited, false);
  assert.equal(
    ctx.bytes,
    undefined,
    "the window loads the file itself while stopped",
  );
});

test("the context carries the image file a chip was loaded from", async () => {
  resetDom();
  const { calls } = install({ files: new Map([[GUID, new Uint8Array(8192)]]) });
  makeBridge({
    comp: rom({
      storage: { guid: GUID, source: "/roms/blink.bin", edited: true },
      programmed: true,
    }),
  });

  hostInbound("c1", { kind: "ready" });
  await settle();
  const ctx = calls.toInspector.at(-1)[1];
  assert.equal(ctx.source, "/roms/blink.bin");
  assert.equal(ctx.edited, true);
  // The sidecar is still sent: it is what the inspector keeps as the hover.
  assert.equal(ctx.path, `/mem/${GUID}.bin`);
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
    picked: { ok: true, path: "/roms/prog.bin", bytes: new Uint8Array(8192) },
  });
  const { bridge, controller } = makeBridge({
    comp: rom({ storage: { guid: GUID } }),
  });

  await bridge.program("c1");
  assert.equal(calls.pickImage, 1, "opened the picker");
  assert.deepEqual(calls.program, [[GUID, 8192]], "programmed the file");
  assert.deepEqual(
    controller.calls,
    [["c1", true, { source: "/roms/prog.bin" }, { guid: GUID }]],
    "flagged the chip programmed, and recorded which file it holds",
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
    picked: { ok: true, path: "/roms/small.bin", bytes: new Uint8Array(100) },
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
    picked: { ok: true, path: "/roms/x.bin", bytes: new Uint8Array(8192) },
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
  // No `source`: a hand-edit does not change where the image came from, it
  // marks that the bytes have moved on from it.
  assert.deepEqual(controller.calls, [
    ["c1", true, { edited: true }, { guid: GUID }],
  ]);
});

test("an inspector's Save is answered: its binding on success, its edits handed back on failure", async () => {
  resetDom();
  const { calls } = install({ files: new Map([[GUID, new Uint8Array(8192)]]) });
  const comp = rom({ storage: { guid: GUID, source: "/roms/a.bin" } });
  const { controller } = makeBridge({ comp });
  // The fake controller flags nothing itself: the chip as flagged.
  controller.setMemoryProgrammed = () => ((comp.params.storage.edited = true), true); // prettier-ignore
  hostInbound("c1", { kind: "save", bytes: [1] });
  await settle();
  assert.deepEqual(calls.toInspector.at(-1), ["c1", { kind: "saved", source: "/roms/a.bin", edited: true }], "the line says (edited) — no reload over newer typing"); // prettier-ignore
  window.chiphippo.mem.write = async () => ({ ok: false, error: "disk full" });
  hostInbound("c1", { kind: "save", bytes: [2] });
  await settle();
  assert.deepEqual(calls.toInspector.at(-1), ["c1", { kind: "save-failed" }], "unsaved again: Save is offered again"); // prettier-ignore
});

test("an inspector's unsaved edits reach the desk, and leave it when the window closes", () => {
  resetDom();
  install({ files: new Map([[GUID, new Uint8Array(8192)]]) });
  const { controller } = makeBridge({ comp: rom({ storage: { guid: GUID } }) });
  const unsaved = [];
  controller.setMemoryUnsaved = (id, on) => unsaved.push([id, on]);
  hostInbound("c1", { kind: "edits", unsaved: true });
  hostInbound("c1", { kind: "edits", unsaved: false });
  hostInbound("c1", { kind: "edits", unsaved: true });
  // main's word that the window has gone: its edits went with it
  hostInbound("c1", { kind: "closed" });
  assert.deepEqual(unsaved, [
    ["c1", true],
    ["c1", false],
    ["c1", true],
    ["c1", false],
  ]);
});

test("Program asks again after the picker whether a run has started", async () => {
  resetDom();
  const { calls } = install({ files: new Map([[GUID, new Uint8Array(8192)]]) });
  const { bridge, sim, notifications } = makeBridge({ comp: rom({ storage: { guid: GUID } }) }); // prettier-ignore
  window.chiphippo.mem.pickImage = async () => {
    sim.running = true; // ⌘R while the dialog was up
    return { bytes: new Uint8Array(8192), path: "/roms/a.bin" };
  };
  await bridge.program("c1");
  assert.deepEqual(calls.program, [], "not written under the run");
  assert.equal(notifications.calls.at(-1).variant, "danger");
});

test("a picker that fails after the click is said, not taken for a cancel", async () => {
  resetDom();
  const { calls } = install({ files: new Map([[GUID, new Uint8Array(8192)]]) });
  const { bridge, notifications } = makeBridge({ comp: rom({ storage: { guid: GUID } }) }); // prettier-ignore
  window.chiphippo.mem.pickImage = async () => {
    throw new Error("the browser refused the file");
  };
  await bridge.program("c1");
  assert.deepEqual(calls.program, [], "nothing written");
  const last = notifications.calls.at(-1);
  assert.equal(last.variant, "danger");
  assert.match(
    String(last.message ?? last.body ?? JSON.stringify(last)),
    /refused the file/,
  );
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

// ── The shipped demos, end to end ────────────────────────────────────────────
// The unit tests above hand the bridge a chip that already HAS a store, which
// is why none of them caught this: a ROM in a document read from a FILE was
// never placed or pasted, so it had none, `#romInfo` answered null, and every
// entry point fell through its own `if (!info) return`. "Load image…" opened
// nothing and said nothing. This drives the REAL `demos/65xx-lcd.chiphippo`
// through the REAL controller, which is the only shape that reproduces it.

test("a shipped demo's ROM can be programmed straight after opening it", async () => {
  resetDom();
  const { DeskDoc } = await import("../model/desk-doc.js");
  const { DeskController } = await import("../components/desk-controller.js");
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const demo = (n) => fileURLToPath(new URL(`../../../../demos/${n}`, import.meta.url)); // prettier-ignore

  const hex = readFileSync(demo("65xx-lcd.hex"), "utf8");
  const hexText = new TextEncoder().encode(hex);
  const { calls } = install({
    picked: { ok: true, path: "/roms/65xx-lcd.hex", bytes: hexText },
  });

  const doc = new DeskDoc(null);
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const controller = new DeskController({
    viewport,
    deskView: {
      surface,
      camera: { cx: 0, cy: 0, zoom: 1 },
      worldFromEvent: () => ({ x: 0, y: 0 }),
      setCamera: () => {},
    },
    deskDoc: doc,
    onCreateMemoryFile: () => {},
  });
  controller.loadDocument(JSON.parse(readFileSync(demo("65xx-lcd.chiphippo"), "utf8"))); // prettier-ignore

  const rom = doc.components.find((c) => c.ref === "rom-8k");
  const guid = rom.params?.storage?.guid;
  assert.ok(guid, "opening the demo gave its ROM a backing store");

  const bridge = new MemoryBridge({
    deskDoc: doc,
    sim: { running: false },
    controller,
    bridge: window.chiphippo,
    notifications: { notify: () => {} },
  });
  await bridge.program(rom.id);
  await settle();

  assert.equal(calls.pickImage, 1, "the file picker opened");
  assert.deepEqual(
    calls.program,
    [[guid, 8192]],
    "and the whole 8 KiB image went to the chip's own file",
  );
  // The extension is read off the PICKED PATH, so a `.hex` is decoded to its
  // bytes rather than written as the text it is — invisible in the tuple
  // above, whose byteLength comes from the part def either way.
  assert.notEqual(calls.programBytes[0].length, hexText.length);
  assert.ok(calls.programBytes[0].length <= 8192);
  assert.equal(
    doc.getComponent(rom.id).params.programmed,
    true,
    "the chip is flagged programmed, so the sim will load it on Run",
  );
});

test("a run starting hands every open inspector its RUNNING context", async () => {
  // Stop always told a window the run had ended; nothing told it one had
  // begun. A window opened while stopped read "Stopped · editable" all run,
  // and an SRAM's showed deltas over a zeroed grid instead of the live image.
  resetDom();
  const { calls } = install({ files: new Map([[GUID, new Uint8Array(8192)]]) });
  const comp = rom({ storage: { guid: GUID } });
  const sim = { running: false, imageBytesOf: () => Uint8Array.from([7, 8]) };
  new MemoryBridge({
    deskDoc: { getComponent: (id) => (id === comp.id ? comp : null) },
    sim,
    controller: { setMemoryProgrammed() {} },
    bridge: window.chiphippo,
    notifications: { notify() {} },
  });
  hostInbound("c1", { kind: "ready" });
  await settle();
  assert.equal(calls.toInspector.at(-1)[1].running, false);

  sim.running = true;
  memState({ running: true, started: true, changes: new Map() });
  await settle();
  const ctx = calls.toInspector.at(-1)[1];
  assert.equal(ctx.kind, "context");
  assert.equal(ctx.running, true);
  assert.deepEqual([...ctx.bytes], [7, 8]);
});

/** One Intel HEX data record. */
function hexRecord(addr, data, type = 0) {
  const head = [data.length, (addr >> 8) & 0xff, addr & 0xff, type, ...data];
  const sum = (0x100 - (head.reduce((a, b) => a + b, 0) & 0xff)) & 0xff;
  return ":" + [...head, sum].map((b) => b.toString(16).padStart(2, "0")).join(""); // prettier-ignore
}

test("a HEX file lands at its OWN addresses, modulo the ROM — vectors and all", async () => {
  resetDom();
  // A program .org $E100 with its reset vector at $FFFA, into an 8 KiB ROM:
  // the code belongs at $0100 and the vector at $1FFA (rebased to its lowest
  // address, the vector would have landed at $1EFA).
  const text = [hexRecord(0xe100, [0xa9, 0x42]), hexRecord(0xfffa, [0x00, 0xe1]), ":00000001FF"].join("\n"); // prettier-ignore
  const current = new Uint8Array(8192).fill(0x5a); // what the chip held
  const { calls } = install({
    files: new Map([[GUID, current]]),
    picked: { ok: true, path: "/roms/prog.hex", bytes: new TextEncoder().encode(text) }, // prettier-ignore
  });
  window.chiphippo.mem.load = () => Promise.resolve({ ok: true, bytes: current }); // prettier-ignore
  const { bridge, notifications } = makeBridge({ comp: rom({ storage: { guid: GUID } }) }); // prettier-ignore
  await bridge.program("c1");
  const image = calls.programBytes[0];
  assert.equal(image.length, 8192, "a whole image — no size mismatch");
  assert.deepEqual([image[0x100], image[0x101]], [0xa9, 0x42]);
  assert.deepEqual([image[0x1ffa], image[0x1ffb]], [0x00, 0xe1]);
  assert.equal(image[0x0000], 0x5a, "bytes the file never mentions keep what they held"); // prettier-ignore
  assert.ok(!notifications.calls.some((c) => /mismatch/i.test(c.title)));
});

test("keepRunEdits saves a ROM's run bytes as Save does, and reloads its inspector", async () => {
  resetDom();
  const { calls } = install({ files: new Map([[GUID, new Uint8Array(8192)]]) });
  const { bridge, controller } = makeBridge({ comp: rom({ storage: { guid: GUID } }) }); // prettier-ignore
  hostInbound("c1", { kind: "ready" }); // an inspector is open on it
  await settle();
  calls.toInspector.length = 0;
  assert.equal(await bridge.keepRunEdits("c1", new Uint8Array([9, 8, 7])), true); // prettier-ignore
  assert.deepEqual(calls.write, [[GUID, [9, 8, 7]]]);
  assert.deepEqual(controller.calls, [
    ["c1", true, { edited: true }, { guid: GUID }],
  ]);
  await settle();
  assert.equal(
    calls.toInspector.at(-1)?.[1]?.kind,
    "context",
    "told to reload",
  );
});

test("a ROM write flags its chip where it BEGAN — asked of the workspace, whatever the desk holds by then", async () => {
  resetDom();
  const { calls } = install({ files: new Map([[GUID, new Uint8Array(8192)]]) });
  let land;
  const written = new Promise((r) => (land = r));
  window.chiphippo.mem.write = (g, b) => (calls.write.push([g, [...b]]), written.then(() => ({ ok: true }))); // prettier-ignore
  const elsewhere = [];
  let changed = 0;
  let stillOpen = true;
  const { bridge, controller } = makeBridge({
    comp: rom({ storage: { guid: GUID } }),
    whereNow: () => ({ project: 1, tab: "t1" }),
    markKept: (where, id, binding, guid) => (elsewhere.push([where, id, binding, guid]), stillOpen), // prettier-ignore
    onImagesChanged: () => (changed += 1),
  });
  const keeping = bridge.keepRunEdits("c1", new Uint8Array([1]));
  // A swap and the leave question can wait for it while it is under way.
  const held = [];
  window.dispatchEvent(new CustomEvent("chiphippo:writes-pending", { detail: { hold: (p) => held.push(p) } })); // prettier-ignore
  assert.equal(held.length, 1, "in flight: held");
  // The desk changes under it, then the write lands.
  window.dispatchEvent(new CustomEvent("chiphippo:desk-loaded"));
  land();
  assert.equal(await keeping, true, "kept — in the desktop it was made on");
  assert.deepEqual(controller.calls, [], "not the chip on the desk NOW: the workspace decides"); // prettier-ignore
  assert.deepEqual(elsewhere, [[{ project: 1, tab: "t1" }, "c1", { edited: true }, GUID]], "with the file it went to"); // prettier-ignore
  assert.deepEqual(calls.write, [[GUID, [1]]], "written once, nothing read back first"); // prettier-ignore
  assert.equal(changed, 1, "its project has bytes to save");
  // The next one has nothing to flag (that project has gone): no •.
  stillOpen = false;
  const later = bridge.keepRunEdits("c1", new Uint8Array([2]));
  window.dispatchEvent(new CustomEvent("chiphippo:desk-loaded"));
  land();
  assert.equal(await later, false, "written, but no chip names it: not kept");
  assert.equal(changed, 1, "nothing flagged, nothing marked edited");
  assert.equal(
    elsewhere.length,
    2,
    "offered to where it was made, all the same",
  );
  const after = [];
  window.dispatchEvent(new CustomEvent("chiphippo:writes-pending", { detail: { hold: (p) => after.push(p) } })); // prettier-ignore
  assert.equal(after.length, 0, "landed: nothing left to hold");
});

test("Program stamps where it began BEFORE the picker; a write that throws is a failed one", async () => {
  resetDom();
  install({ files: new Map([[GUID, new Uint8Array(8192)]]) });
  let tab = "t1";
  const marked = [];
  window.chiphippo.mem.pickImage = async () => {
    tab = "t2"; // a desktop switch while the dialog is up
    return { bytes: new Uint8Array(8192), path: "/roms/a.bin" };
  };
  const { bridge, notifications } = makeBridge({
    comp: rom({ storage: { guid: GUID } }),
    whereNow: () => ({ project: 1, tab }),
    markKept: (where, id, binding, guid) => (marked.push([where.tab, id, binding, guid]), true), // prettier-ignore
  });
  await bridge.program("c1");
  assert.deepEqual(marked, [["t1", "c1", { source: "/roms/a.bin" }, GUID]], "the desktop the chip was picked on"); // prettier-ignore
  // A write whose IPC throws: said, not an unhandled rejection.
  window.chiphippo.mem.write = async () => {
    throw new Error("disk gone");
  };
  assert.equal(await bridge.keepRunEdits("c1", new Uint8Array([1])), false);
  assert.match(JSON.stringify(notifications.calls.at(-1)), /disk gone/);
  assert.equal(marked.length, 1, "nothing flagged for it");
});

test("with no workspace to ask, a write landing after the desk changed flags nothing", async () => {
  resetDom();
  install({ files: new Map([[GUID, new Uint8Array(8192)]]) });
  let land;
  const written = new Promise((r) => (land = r));
  window.chiphippo.mem.write = () => written.then(() => ({ ok: true }));
  let changed = 0;
  const { bridge, controller } = makeBridge({
    comp: rom({ storage: { guid: GUID } }),
    onImagesChanged: () => (changed += 1),
  });
  const keeping = bridge.keepRunEdits("c1", new Uint8Array([1]));
  window.dispatchEvent(new CustomEvent("chiphippo:desk-loaded"));
  land();
  assert.equal(await keeping, false);
  assert.deepEqual(controller.calls, [], "not whatever chip c1 is now");
  assert.equal(changed, 0);
  // Landing on the same desk: flagged there, with the file it went to.
  window.chiphippo.mem.write = async () => ({ ok: true });
  assert.equal(await bridge.keepRunEdits("c1", new Uint8Array([1])), true);
  assert.deepEqual(controller.calls, [["c1", true, { edited: true }, { guid: GUID }]]); // prettier-ignore
  assert.equal(changed, 1);
});

test("keepRunEdits refuses while running, and an SRAM has nothing to keep", async () => {
  resetDom();
  install({ files: new Map([[GUID, new Uint8Array(8192)]]) });
  let { bridge } = makeBridge({ running: true, comp: rom({ storage: { guid: GUID } }) }); // prettier-ignore
  assert.equal(await bridge.keepRunEdits("c1", new Uint8Array(1)), false);
  resetDom();
  install();
  ({ bridge } = makeBridge({ comp: sram() }));
  assert.equal(await bridge.keepRunEdits("c1", new Uint8Array(1)), false);
});

test("a HEX image under another name (SDCC's .ihx, or none) is decoded, never programmed as its ASCII", async () => {
  for (const path of ["/roms/prog.ihx", "/roms/prog.rom", "/roms/prog"]) {
    resetDom();
    const text = [hexRecord(0x0100, [0xa9, 0x42]), ":00000001FF"].join("\n");
    const { calls } = install({
      files: new Map([[GUID, new Uint8Array(8192)]]),
      picked: { ok: true, path, bytes: new TextEncoder().encode(text) },
    });
    const { bridge } = makeBridge({ comp: rom({ storage: { guid: GUID } }) });
    await bridge.program("c1");
    const image = calls.programBytes[0];
    assert.equal(image.length, 8192, path);
    assert.deepEqual([image[0x100], image[0x101]], [0xa9, 0x42], path);
  }
});

test("a HEX file with no data records programs nothing, and says why", async () => {
  resetDom();
  const { calls } = install({
    files: new Map([[GUID, new Uint8Array(8192)]]),
    picked: { ok: true, path: "/roms/empty.hex", bytes: new TextEncoder().encode(":00000001FF\n") }, // prettier-ignore
  });
  const { bridge, controller, notifications } = makeBridge({ comp: rom({ storage: { guid: GUID } }) }); // prettier-ignore
  await bridge.program("c1");
  assert.deepEqual(calls.program, [], "nothing written");
  assert.deepEqual(controller.calls, [], "and the chip not flagged programmed");
  assert.ok(notifications.calls.some((c) => /no data records/.test(c.message ?? "")), JSON.stringify(notifications.calls)); // prettier-ignore
});
