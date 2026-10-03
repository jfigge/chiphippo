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

/**
 * tests/datasheet-download.test.js
 *
 * Settings ▸ Data Sheets ▸ Download… (app/datasheets/download.js) against a
 * STUB fetch — no network, ever. What it has to get right is what happens
 * when a source goes bad, because one eventually will: a 404, a host that
 * answers a missing file with a friendly HTML page and status 200, a dead
 * connection. Each is one part reported by name, never the end of the run.
 * And a sheet several parts share (TI documents the CD4001B, CD4002B and
 * CD4025B in one PDF) is fetched ONCE and saved under every part's name.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { downloadAll } = require("../datasheets/download");

const BASE = "https://example.test/sheets/";
const PDF = Buffer.from("%PDF-1.4 a real enough datasheet");
const HTML = Buffer.from("<!doctype html><p>Sorry, that page moved</p>");

/** A sources table in DATASHEET_SOURCES's shape. */
function sources(entries) {
  return Object.fromEntries(
    Object.entries(entries).map(([ref, file]) => [
      ref,
      { ref, url: new URL(file, BASE).href, base: BASE, library: "test" },
    ]),
  );
}

/** A fetch stub answering per file name; records every URL it was asked for. */
function stubFetch(answers) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const answer = answers[url.slice(BASE.length)];
    if (answer instanceof Error) throw answer;
    if (typeof answer === "number") {
      return {
        ok: false,
        status: answer,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        answer.buffer.slice(
          answer.byteOffset,
          answer.byteOffset + answer.length,
        ),
    };
  };
  return { fetch, calls };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-ds-"));

test("one bad source among good ones is reported by name; the rest are saved", async () => {
  const dir = tmp();
  const { fetch } = stubFetch({
    "a.pdf": PDF,
    "gone.pdf": 404,
    "moved.pdf": HTML,
    "down.pdf": new Error("ECONNRESET"),
    "e.pdf": PDF,
  });
  const progress = [];
  const result = await downloadAll({
    dir,
    signal: new AbortController().signal,
    sources: sources({
      A1: "a.pdf",
      B1: "gone.pdf",
      C1: "moved.pdf",
      D1: "down.pdf",
      E1: "e.pdf",
    }),
    fetch,
    onProgress: (p) => progress.push(p),
  });
  assert.equal(result.total, 5);
  assert.equal(result.saved, 2);
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.failures, [
    { ref: "B1", error: "HTTP 404" },
    { ref: "C1", error: "the reply was not a PDF" },
    { ref: "D1", error: "ECONNRESET" },
  ]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["A1.pdf", "E1.pdf"]);
  // A 200 that is not a PDF never lands on disk.
  assert.ok(!fs.existsSync(path.join(dir, "C1.pdf")));
  // Progress counts every part, good and bad, ending at the total.
  assert.deepEqual(
    progress.map((p) => p.done),
    [0, 1, 2, 3, 4, 5],
  );
});

test("a sheet several parts share is fetched once and saved under each part", async () => {
  const dir = tmp();
  const { fetch, calls } = stubFetch({ "family.pdf": PDF, "solo.pdf": PDF });
  const result = await downloadAll({
    dir,
    signal: new AbortController().signal,
    sources: sources({
      CD4001B: "family.pdf",
      CD4002B: "family.pdf",
      CD4025B: "family.pdf",
      CD4078B: "solo.pdf",
    }),
    fetch,
  });
  assert.equal(result.saved, 4);
  assert.equal(calls.length, 2, "one request per unique URL");
  for (const ref of ["CD4001B", "CD4002B", "CD4025B"]) {
    assert.deepEqual(fs.readFileSync(path.join(dir, `${ref}.pdf`)), PDF);
  }
});

test("a shared sheet that fails fails every part sharing it, each by name", async () => {
  const dir = tmp();
  const { fetch, calls } = stubFetch({ "family.pdf": 404, "ok.pdf": PDF });
  const result = await downloadAll({
    dir,
    signal: new AbortController().signal,
    sources: sources({ X1: "family.pdf", X2: "ok.pdf", X3: "family.pdf" }),
    fetch,
  });
  assert.equal(calls.length, 2, "the failed URL is not retried per part");
  assert.deepEqual(result.failures, [
    { ref: "X1", error: "HTTP 404" },
    { ref: "X3", error: "HTTP 404" },
  ]);
  assert.equal(result.saved, 1);
});

test("cancelling stops the run between parts", async () => {
  const dir = tmp();
  const ctrl = new AbortController();
  const { fetch } = stubFetch({ "a.pdf": PDF, "b.pdf": PDF });
  const result = await downloadAll({
    dir,
    signal: ctrl.signal,
    sources: sources({ A1: "a.pdf", B1: "b.pdf" }),
    fetch,
    onProgress: (p) => {
      if (p.ref === "A1") ctrl.abort();
    },
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.saved, 1);
});
