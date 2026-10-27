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

// ipc.js — which IPC call a write to the visitor's disk is answered to when
// an async handler makes it after an await, with another call out beside it.

import test from "node:test";
import assert from "node:assert/strict";
import { ctx } from "../context.js";
import { ipcMain, dispatch, currentCalls } from "../ipc.js";
import { Persist, openDatabase } from "../persist.js";
import { Mounts } from "../mounts.js";
import { fakeIndexedDB } from "./fake-indexeddb.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a write after an await is answered to its call, not one beside it running no handler", async () => {
  const real = globalThis.structuredClone;
  globalThis.structuredClone = (v) => {
    try {
      return real(v);
    } catch {
      return v;
    }
  };
  try {
    const db = await openDatabase(fakeIndexedDB(new Map()));
    let mounts = null;
    ctx.persist = new Persist(db, ctx.vfs, (p) => mounts?.keep(p) ?? false);
    mounts = new Mounts({
      vfs: ctx.vfs,
      persist: ctx.persist,
      download: () => {},
      owner: currentCalls,
    });
    ctx.mounts = mounts;
    ctx.persist.start();
    mounts.start();
    const fileOn = (name, fail) => {
      const handle = {
        kind: "file",
        name,
        // slow to say (the browser checking): a re-read takes a while
        queryPermission: async () => (await sleep(20), "granted"),
        getFile: async () =>
          Object.assign(new Blob(["x"]), { lastModified: 1 }),
        requestPermission: async () => "granted",
        isSameEntry: async (o) => o === handle,
        createWritable: async () => ({
          write: async () => {
            await sleep(15);
            if (fail) throw new Error(fail);
          },
          close: async () => {},
        }),
      };
      return mounts.mountFile(handle, { read: false });
    };
    const p = await fileOn("Board.kicad_sch", "disk full");
    const recent = await fileOn("Bench.chiphippo", null);

    // An export: a dialog (an await), then the write, then more awaiting.
    ipcMain.handle("test:export", async () => {
      await sleep(5);
      ctx.vfs.writeFileSync(p, "schematic");
      await sleep(40);
      return { ok: true };
    });
    // An Open Recent beside it, still re-reading its file (ipc.js BEFORE)
    // when the export writes — out, but no handler of its running.
    ipcMain.handle("project:open-recent", () => ({ ok: true }));

    const outcome = (q) =>
      q.then(
        () => "ok",
        (e) => e.message,
      );
    const exporting = outcome(dispatch(null, "test:export", []));
    await sleep(1);
    const opening = outcome(dispatch(null, "project:open-recent", [recent]));
    assert.equal(await opening, "ok", "the call beside it is not blamed");
    assert.match(await exporting, /disk full/, "the export is told");
  } finally {
    globalThis.structuredClone = real;
    ctx.persist = null;
    ctx.mounts = null;
  }
});
