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

// website-chips.test.js — website/chips.html, the supported-chips list, is
// GENERATED from the catalog by scripts/build-chips-page.mjs. These hold the
// generator to the catalog (every chip listed once, the ✦ exactly where an
// example circuit ships) and the committed page to the generator.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

import {
  OUT,
  chipSections,
  renderChipsPage,
} from "../../../../scripts/build-chips-page.mjs";
import { CHIP_DEFS } from "../catalog/index.js";

const DEMOS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../demos",
);

const rowsOf = (sections) => sections.flatMap((s) => s.rows);

test("every catalog chip is listed exactly once", () => {
  const ids = rowsOf(chipSections()).map((r) => r.id);
  assert.equal(ids.length, new Set(ids).size, "a chip listed twice");
  assert.deepEqual([...ids].sort(), CHIP_DEFS.map((d) => d.id).sort());
});

test("the ✦ marks exactly the chips that ship an example circuit", () => {
  // The same file test main answers the pinout window's example button with.
  const marked = rowsOf(chipSections())
    .filter((r) => r.example)
    .map((r) => r.id)
    .sort();
  const shipped = CHIP_DEFS.map((d) => d.id)
    .filter((id) => existsSync(path.join(DEMOS_DIR, `${id}.json`)))
    .sort();
  assert.ok(shipped.length > 0, "no example circuits found at all");
  assert.deepEqual(marked, shipped);
});

test("rows read in part-number order within a band", () => {
  const gates = chipSections().find((s) => s.id === "gates");
  const ids = gates.rows.map((r) => r.id);
  // The logic families interleave by number; the bus buffers come after.
  assert.ok(ids.indexOf("74LS00") < ids.indexOf("74LS01"));
  assert.ok(ids.indexOf("74LS86") < ids.indexOf("74LS125"));
  const counters = chipSections().find((s) => s.id === "counters");
  const cids = counters.rows.map((r) => r.id);
  // Counters band before shift registers, whatever the numbers say.
  assert.ok(cids.indexOf("74LS193") < cids.indexOf("74LS164"));
});

test("a chip in a group no section claims fails the build", () => {
  const stray = { id: "74LS999", title: "Mystery", group: "Mystery" };
  assert.throws(
    () => chipSections([...CHIP_DEFS, stray], () => false),
    /74LS999.*Mystery/,
  );
});

test("a section naming a group no chip has fails the build", () => {
  const defs = CHIP_DEFS.filter((d) => d.group !== "Comparator");
  assert.throws(() => chipSections(defs, () => false), /Comparator/);
});

test("the page states the derived counts", () => {
  const html = renderChipsPage();
  const doc = new JSDOM(html).window.document;
  assert.match(
    doc.querySelector("main h1 + p").textContent,
    new RegExp(`ships ${CHIP_DEFS.length} chips`),
  );
  const rows = doc.querySelectorAll(".chip-table tbody tr");
  assert.equal(rows.length, CHIP_DEFS.length);
  for (const h2 of doc.querySelectorAll("main h2")) {
    const table = h2.nextElementSibling.querySelector("tbody");
    assert.equal(
      h2.querySelector(".count").textContent,
      String(table.children.length),
      `${h2.id}'s heading count`,
    );
  }
});

test("every jump link and external link on the page is sound", () => {
  const doc = new JSDOM(renderChipsPage()).window.document;
  const dead = [...doc.querySelectorAll('a[href^="#"]')]
    .map((a) => a.getAttribute("href").slice(1))
    .filter((id) => !doc.getElementById(id));
  assert.deepEqual(dead, []);
  const bad = [...doc.querySelectorAll("a[href]")]
    .filter((a) => /^https?:/.test(a.getAttribute("href")))
    .filter((a) => !(a.getAttribute("rel") || "").includes("noopener"))
    .map((a) => a.getAttribute("href"));
  assert.deepEqual(bad, []);
});

test("the committed website/chips.html is current (run `make docs`)", () => {
  // The deploy workflow regenerates it anyway; this keeps the copy in the repo
  // — and so a local preview of the site — from quietly lagging the catalog.
  assert.equal(readFileSync(OUT, "utf8"), renderChipsPage());
});
