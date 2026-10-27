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

// storage.test.js — persist.js (IndexedDB behind the in-memory filesystem) and
// mounts.js (the visitor's own files) on their own, over the fake IndexedDB:
// a refused flush retried and not blamed on later callers, `busy` through a
// transaction, a hold keeping a deletion out of storage, a picked file that
// changed on disk since it was last read, and write-back errors answered to
// the call that made them.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Vfs } from "../vfs.js";
import { Persist, openDatabase } from "../persist.js";
import { Mounts, mainReadsSync } from "../mounts.js";
import { fakeIndexedDB } from "./fake-indexeddb.js";

const require = createRequire(import.meta.url);
const { writeKicadFolder } = require("../../app/ipc/export.js");

async function storage({
  failWrites = 0,
  keep = (p) => p.startsWith("/userData"),
} = {}) {
  const databases = new Map();
  const db = await openDatabase(fakeIndexedDB(databases));
  const realTx = db.transaction.bind(db);
  let failing = failWrites;
  db.transaction = (name, mode) => {
    const tx = realTx(name, mode);
    if (mode === "readwrite" && name === "files" && failing-- > 0) {
      const objectStore = tx.objectStore.bind(tx);
      tx.objectStore = (n) => {
        const s = objectStore(n);
        s.put = () => {
          throw Object.assign(new Error("QuotaExceededError"), {
            name: "QuotaExceededError",
          });
        };
        return s;
      };
    }
    return tx;
  };
  const vfs = new Vfs();
  vfs.mkdirSync("/userData", { recursive: true });
  const persist = new Persist(db, vfs, keep);
  persist.start();
  const files = () => databases.get("chiphippo").stores.get("files");
  return { vfs, persist, files };
}

const quiet = async (fn) => {
  const error = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = error;
  }
};

test("one refused flush is retried, and not answered to callers that wrote nothing", () =>
  quiet(async () => {
    const { vfs, persist, files } = await storage({ failWrites: 1 });
    vfs.writeFileSync("/userData/a.json", "{}");
    await assert.rejects(persist.idle(), /Quota/);
    assert.equal(persist.busy, true, "the refused write is still owed");
    // A reader's idle retries it — and this time it lands.
    await persist.idle();
    assert.ok(files().has("/userData/a.json"), "retried into storage");
    assert.equal(persist.busy, false);
    await persist.idle();
  }));

test("busy holds through a transaction in flight", async () => {
  const { vfs, persist } = await storage();
  vfs.writeFileSync("/userData/big.json", "x".repeat(1000));
  const flushed = persist.idle();
  assert.equal(persist.busy, true);
  await flushed;
  assert.equal(persist.busy, false);
});

test("a hold keeps a deletion out of storage until it lifts", async () => {
  const { vfs, persist, files } = await storage();
  vfs.writeFileSync("/userData/slot", "work");
  await persist.idle();
  const release = persist.hold();
  vfs.unlinkSync("/userData/slot");
  const waiting = persist.idle();
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(files().has("/userData/slot"), "held");
  // Undone before the hold lifts: storage never sees it gone.
  vfs.writeFileSync("/userData/slot", "work");
  release();
  await waiting;
  await persist.idle();
  assert.ok(files().has("/userData/slot"));
});

function fakeHandle(name, { fail = null } = {}) {
  const disk = { bytes: new Uint8Array(0), lastModified: 100 };
  const handle = {
    kind: "file",
    name,
    disk,
    queryPermission: async () => "granted",
    requestPermission: async () => "granted",
    isSameEntry: async (o) => o === handle,
    getFile: async () =>
      Object.assign(new Blob([disk.bytes]), {
        lastModified: disk.lastModified,
      }),
    createWritable: async () => ({
      write: async (bytes) => {
        if (fail) throw new Error(fail);
        disk.bytes = new Uint8Array(bytes);
        disk.lastModified += 1;
      },
      close: async () => {},
    }),
  };
  return handle;
}

async function mounted({ owner = () => null, confirmReplace } = {}) {
  const real = globalThis.structuredClone;
  // the fake IndexedDB clones records; a real handle survives that
  globalThis.structuredClone = (v) => {
    try {
      return real(v);
    } catch {
      return v;
    }
  };
  let mounts = null;
  // what the host keeps: main's own files and the picked ones (mounts.keep)
  const s = await storage({ keep: (p) => mounts?.keep(p) ?? false });
  mounts = new Mounts({
    vfs: s.vfs,
    persist: s.persist,
    download: () => {},
    owner,
    confirmReplace,
  });
  mounts.start();
  return { ...s, mounts, restore: () => (globalThis.structuredClone = real) };
}

test("a picked file changed on disk since it was read is not written over unasked", async () => {
  const asked = [];
  let answer = false;
  const m = await mounted({
    confirmReplace: async (name) => (asked.push(name), answer),
  });
  try {
    const handle = fakeHandle("Bench.chiphippo");
    handle.disk.bytes = new TextEncoder().encode("v1");
    const p = await m.mounts.mountFile(handle);
    m.vfs.writeFileSync(p, "v2 (ours)");
    await m.mounts.idle();
    assert.equal(new TextDecoder().decode(handle.disk.bytes), "v2 (ours)");
    assert.deepEqual(asked, [], "nothing changed elsewhere: no question");

    // Changed elsewhere (another app, another browser)…
    handle.disk.bytes = new TextEncoder().encode("v3 (newer)");
    handle.disk.lastModified += 50;
    m.vfs.writeFileSync(p, "v2 + an edit");
    await assert.rejects(m.mounts.idle(), /changed outside/);
    assert.deepEqual(asked, ["Bench.chiphippo"]);
    assert.equal(new TextDecoder().decode(handle.disk.bytes), "v3 (newer)");

    // …and replaced only when the visitor says so.
    answer = true;
    m.vfs.writeFileSync(p, "v2 + an edit");
    await m.mounts.idle();
    assert.equal(new TextDecoder().decode(handle.disk.bytes), "v2 + an edit");
  } finally {
    m.restore();
  }
});

test("a write-back error is kept for the call that made it", async () => {
  let owner = null;
  const m = await mounted({ owner: () => owner });
  try {
    const handle = fakeHandle("Bench.chiphippo", { fail: "disk full" });
    const p = await m.mounts.mountFile(handle, { read: false });
    const save = { channel: "project:save" };
    const other = { channel: "settings:get" };
    owner = save;
    m.vfs.writeFileSync(p, "work");
    owner = null;
    assert.equal(m.mounts.owes(save), true);
    assert.equal(m.mounts.owes(other), false);
    await m.mounts.idle(other); // a call beside it settles clean
    await assert.rejects(m.mounts.idle(save), /disk full/);
    assert.equal(m.mounts.owes(save), false);
  } finally {
    m.restore();
  }
});

test("a call's write the timer's flush already lost is still that call's failure", () =>
  quiet(async () => {
    const { vfs, persist, files } = await storage({ failWrites: 2 });
    const since = persist.generation; // the call begins
    vfs.writeFileSync("/userData/project.chiphippo", "{}"); // its write
    // An async handler's later await: the timer flushes, and is refused.
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(persist.idle(since), /Quota/);
    // A call begun after it wrote nothing: not its failure (the retry lands).
    await persist.idle(persist.generation);
    assert.ok(files().has("/userData/project.chiphippo"));
  }));

test("a picked file re-read from disk is what storage keeps", async () => {
  const m = await mounted();
  try {
    const handle = fakeHandle("Bench.chiphippo");
    handle.disk.bytes = new TextEncoder().encode("v2 (from the web)");
    const p = await m.mounts.mountFile(handle);
    await m.persist.idle();
    // Saved newer elsewhere; a visit that may read it reads it…
    handle.disk.bytes = new TextEncoder().encode("v3 (newer, on disk)");
    handle.disk.lastModified += 50;
    assert.equal(await m.mounts.refreshPath(p, { ask: false }), true);
    // …and storage holds THOSE bytes, the ones its recorded time is for — so
    // a later visit that cannot read the file boots v3, not v2.
    assert.equal(
      new TextDecoder().decode(m.files().get(p).data),
      "v3 (newer, on disk)",
    );
  } finally {
    m.restore();
  }
});

test("a picked file rewritten elsewhere with the same bytes is not asked about", async () => {
  const asked = [];
  const m = await mounted({
    confirmReplace: async (n) => (asked.push(n), false),
  });
  try {
    const handle = fakeHandle("Bench.chiphippo");
    handle.disk.bytes = new TextEncoder().encode("v1");
    const p = await m.mounts.mountFile(handle);
    m.vfs.writeFileSync(p, "v2");
    await m.mounts.idle();
    // A sync client (or an editor) writes it back unchanged: only the time moves.
    handle.disk.lastModified += 50;
    m.vfs.writeFileSync(p, "v3");
    await m.mounts.idle();
    assert.deepEqual(asked, []);
    assert.equal(new TextDecoder().decode(handle.disk.bytes), "v3");
    // Different bytes still ask.
    handle.disk.bytes = new TextEncoder().encode("theirs");
    handle.disk.lastModified += 50;
    m.vfs.writeFileSync(p, "v4");
    await assert.rejects(m.mounts.idle(), /changed outside/);
    assert.deepEqual(asked, ["Bench.chiphippo"]);
  } finally {
    m.restore();
  }
});

test("a write made under two calls at once is answered to both", async () => {
  let owner = null;
  const m = await mounted({ owner: () => owner });
  try {
    const handle = fakeHandle("Bench.chiphippo", { fail: "disk full" });
    const p = await m.mounts.mountFile(handle, { read: false });
    const a = { channel: "desktop:export" };
    const b = { channel: "export:kicad" };
    owner = [a, b]; // two async handlers mid-await: which wrote, unknown
    m.vfs.writeFileSync(p, "work");
    owner = null;
    await assert.rejects(m.mounts.idle(a), /disk full/);
    await assert.rejects(m.mounts.idle(b), /disk full/, "not taken by a alone");
    await m.mounts.idle(); // and then it is spent
  } finally {
    m.restore();
  }
});

test("a write tagged to a call already answered is not kept for it", async () => {
  let owner = null;
  const m = await mounted({ owner: () => owner });
  try {
    const handle = fakeHandle("Bench.chiphippo", { fail: "disk full" });
    const p = await m.mounts.mountFile(handle, { read: false });
    const a = { channel: "project:save" };
    const b = { channel: "desktop:export" };
    await m.mounts.idle(a); // a has had its answer (it is settling)
    owner = [a, b]; // every call still out, a among them
    m.vfs.writeFileSync(p, "work");
    owner = null;
    assert.equal(m.mounts.owes(a), false, "nothing is owed to a again");
    assert.equal(m.mounts.owes(b), true);
    await assert.rejects(m.mounts.idle(b), /disk full/);
    assert.equal(m.mounts.owes(b), false);
    await m.mounts.idle(); // spent: not kept for a, who will never ask

    // Every call it could name already answered: no call can be named.
    owner = [a, b];
    m.vfs.writeFileSync(p, "more");
    owner = null;
    await assert.rejects(m.mounts.idle({ channel: "settings:get" }), /disk full/); // prettier-ignore
  } finally {
    m.restore();
  }
});

/** A picked folder of `files` (name → bytes) on a fake disk. */
function fakeDir(name, files) {
  const entry = (n) => ({
    kind: "file",
    name: n,
    getFile: async () =>
      Object.assign(new Blob([files[n]]), { name: n, lastModified: 1 }),
  });
  return {
    kind: "directory",
    name,
    queryPermission: async () => "granted",
    requestPermission: async () => "granted",
    isSameEntry: async () => false,
    async *entries() {
      for (const n of Object.keys(files)) yield [n, entry(n)];
    },
  };
}

test("a picked folder reads at once only what main reads synchronously", async () => {
  const m = await mounted();
  try {
    const big = new Uint8Array(300 * 1024).fill(65);
    const dir = await m.mounts.mountDir(
      fakeDir("Export", {
        "board.kicad_sch": big,
        "sym-lib-table": big,
        "board.kicad_pcb": big,
        "TTL.pdf": big,
      }),
      { mode: "readwrite" },
    );
    // A synchronous read, as export.js makes one: the schematic and the
    // library table are there, whatever their size…
    assert.equal(m.vfs.peek(`${dir}/board.kicad_sch`)?.length, big.length);
    assert.equal(m.vfs.peek(`${dir}/sym-lib-table`)?.length, big.length);
    // …and the rest — a board, a datasheet PDF — waits until opened.
    for (const name of ["board.kicad_pcb", "TTL.pdf"]) {
      assert.equal(m.vfs.peek(`${dir}/${name}`), null, name);
      assert.equal(m.vfs.existsSync(`${dir}/${name}`), true, name);
      assert.throws(() => m.vfs.readFileSync(`${dir}/${name}`), {
        code: "EACCES",
      });
      assert.equal((await m.vfs.readFile(`${dir}/${name}`)).length, big.length);
    }

    // A FileList folder (Safari, Firefox) likewise.
    const listed = await m.mounts.mountFileList(
      ["board.kicad_sch", "board.kicad_pcb"].map((name) =>
        Object.assign(new Blob([big]), {
          name,
          webkitRelativePath: `Export/${name}`,
          lastModified: 1,
        }),
      ),
    );
    assert.equal(m.vfs.peek(`${listed}/board.kicad_sch`)?.length, big.length);
    assert.equal(m.vfs.peek(`${listed}/board.kicad_pcb`), null);
  } finally {
    m.restore();
  }
});

test("a folder of large files does not starve the schematic main reads", async () => {
  const m = await mounted();
  try {
    const files = { "board.kicad_sch": new Uint8Array(2 * 2 ** 20).fill(65) };
    for (let i = 0; i < 70; i++) files[`m${i}.step`] = new Uint8Array(2 ** 20);
    const dir = await m.mounts.mountDir(fakeDir("Starve", files), {
      mode: "readwrite",
    });
    assert.equal(
      m.vfs.readFileSync(`${dir}/board.kicad_sch`).length,
      2 * 2 ** 20,
    );
    assert.equal(m.vfs.peek(`${dir}/m0.step`), null, "a model stays lazy");
  } finally {
    m.restore();
  }
});

// MAIN_SYNC_READS is a promise about main's code, so main's code is held to
// it: its KiCad export runs against a picked folder whose every file is too
// large to be read at once unless it is on the list — a synchronous read of
// any other file there fails with EACCES, as it would in a browser.
test("main reads synchronously from a picked folder only MAIN_SYNC_READS", async () => {
  const m = await mounted();
  try {
    const pad = " ".repeat(300 * 1024);
    const ours = `(kicad_sch (version 20231120) (generator "chiphippo")\n${pad})\n`;
    const table = `(sym_lib_table\n  (lib (name "other")(type "KiCad")(uri "x"))\n${pad})\n`;
    const text = (s) => new TextEncoder().encode(s);
    const names = [
      "board.kicad_sch",
      "board.kicad_pro",
      "chiphippo.kicad_sym",
      "sym-lib-table",
    ];
    const disk = Object.fromEntries(names.map((n) => [n, text(pad)]));
    disk["board.kicad_sch"] = text(ours);
    disk["sym-lib-table"] = text(table);
    for (const name of names) {
      assert.equal(
        mainReadsSync(name),
        name === "board.kicad_sch" || name === "sym-lib-table",
        name,
      );
    }
    const dir = await m.mounts.mountDir(fakeDir("Board", disk), {
      mode: "readwrite",
    });
    const res = writeKicadFolder(
      dir,
      names.map((name) => ({
        name,
        text: name === "sym-lib-table" ? `(sym_lib_table\n  (lib (name "chiphippo"))\n)\n` : `(${name})`, // prettier-ignore
      })),
      {
        fs: m.vfs,
        atomicWrite: (p, data) => m.vfs.writeFileSync(p, data),
      },
    );
    assert.equal(res.ok, true);
    assert.deepEqual(res.kept, ["board.kicad_pro"]);
    assert.match(
      m.vfs.readFileSync(`${dir}/sym-lib-table`, "utf8"),
      /chiphippo/,
    );

    // The datasheet folder: main only ever asks whether `<ref>.pdf` is there
    // (and opens it in a tab, through `blob`) — no synchronous read.
    const mainJs = readFileSync(new URL("../../app/main.js", import.meta.url), "utf8"); // prettier-ignore
    for (const fn of [
      "chooseDatasheetDir",
      "datasheetPdfPath",
      "openDatasheetPdf",
    ]) {
      const at = mainJs.indexOf(`function ${fn}(`);
      assert.ok(at >= 0, fn);
      const body = mainJs.slice(at, mainJs.indexOf("\n}\n", at));
      assert.doesNotMatch(body, /readFileSync|openSync|readdirSync/, fn);
    }
  } finally {
    m.restore();
  }
});
