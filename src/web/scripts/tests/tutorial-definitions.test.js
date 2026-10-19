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

// The tutorial definitions are DATA, and data cannot fail loudly on its own:
// a typo'd catalog key renders as the key itself, a misspelt placement as a
// default. So every entry is held to the shape the player reads and every
// text key to en.json (the locale-parity guard then holds the other six to
// it). That every TARGET is registered is app-boot.test.js's to check — only
// a booted app has its widgets.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTO_SHOW_TUTORIAL,
  TUTORIALS,
  tutorialById,
  tutorialTargets,
} from "../tutorials/definitions.js";
import { DECORATIONS, PLACEMENTS } from "../tutorials/geometry.js";

const EN = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../locales/en.json",
    ),
    "utf8",
  ),
);

const lookup = (key) => key.split(".").reduce((node, part) => node?.[part], EN);

test("every tutorial has a unique id and a translated title and description", () => {
  const ids = TUTORIALS.map((tut) => tut.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const tut of TUTORIALS) {
    assert.equal(typeof lookup(tut.title), "string", tut.title);
    assert.equal(typeof lookup(tut.description), "string", tut.description);
    assert.equal(tutorialById(tut.id), tut);
  }
  assert.equal(tutorialById("nope"), null);
});

test("the menu leads with the one auto-shown tour, then the first breadboard", () => {
  assert.deepEqual(TUTORIALS.map((tut) => tut.id).slice(0, 2), [
    "getting-around",
    "first-breadboard",
  ]);
  const auto = TUTORIALS.filter((tut) => tut.autoShow);
  assert.equal(auto.length, 1, "only one tutorial is ever offered unasked");
  assert.equal(auto[0].id, AUTO_SHOW_TUTORIAL);
});

test("every step is in the shape the player reads, its text in en.json", () => {
  const ACTIONS = new Set(["moveTo", "click", "drag"]);
  for (const tut of TUTORIALS) {
    assert.ok(tut.steps.length > 0, tut.id);
    tut.steps.forEach((step, i) => {
      const where = `${tut.id} step ${i + 1}`;
      assert.ok(step.target === null || typeof step.target === "string", where);
      assert.equal(
        typeof lookup(step.callout.text),
        "string",
        `${where}: ${step.callout.text}`,
      );
      assert.ok(PLACEMENTS.includes(step.callout.placement), where);
      assert.ok(DECORATIONS.includes(step.callout.decoration), where);
      assert.ok(["timed", "afterAction"].includes(step.advance.mode), where);
      if (step.advance.mode === "timed") assert.ok(step.advance.ms > 0, where);
      if (step.target === null) {
        assert.equal(
          step.callout.decoration,
          "none",
          `${where}: nothing to decorate`,
        );
      }
      const a = step.action;
      if (!a) return;
      assert.ok(ACTIONS.has(a.type), where);
      if (a.type === "drag") {
        assert.equal(typeof a.from, "string", where);
        assert.equal(typeof a.to, "string", where);
      } else {
        assert.equal(typeof a.target, "string", where);
      }
      if (a.onlyIf)
        assert.ok(["collapsed", "expanded"].includes(a.onlyIf), where);
    });
  }
});

test("Tutorial 1 tours the spec's stops, braces the tray, ends on the book, and builds nothing", () => {
  const steps = tutorialById("getting-around").steps;
  const at = (target) => steps.find((s) => s.target === target);
  assert.equal(at("componentTray")?.callout.decoration, "brace");
  for (const target of [
    "desktop.tabs",
    "toolbar.file",
    "toolbar.tools",
    "toolbar.settings",
  ]) {
    assert.ok(at(target), `points at ${target}`);
  }
  assert.equal(steps.at(-1).target, "toolbar.tutorials", "it ends on the book");
  assert.ok(
    steps.every((s) => s.action?.type !== "drag"),
    "orientation only: nothing is placed",
  );
});

test("Tutorial 2 drags a breadboard from the tray onto the desk", () => {
  const drags = tutorialById("first-breadboard").steps.filter(
    (s) => s.action?.type === "drag",
  );
  assert.equal(drags.length, 1);
  assert.equal(drags[0].action.from, "palette.board.full");
  assert.equal(drags[0].action.to, "desk");
});

test("tutorialTargets names every id a step or action points at, once", () => {
  const ids = tutorialTargets();
  assert.equal(new Set(ids).size, ids.length);
  for (const id of [
    "componentTray",
    "desktop.tabs",
    "palette.board.full",
    "desk",
  ]) {
    assert.ok(ids.includes(id), id);
  }
});
